import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  ExtensionRegistry,
  MikanAgentSession,
  MikanModels,
  SessionStore,
  type HarnessEvent,
} from "../harness/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-harness-runner-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function createFauxSetup(): {
  models: MikanModels;
  faux: ReturnType<typeof fauxProvider>;
  model: Model<Api>;
} {
  // Auth path with a stored key so preflight auth checks pass for the faux provider.
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ faux: { type: "api_key", key: "test-key" } }));
  const models = MikanModels.create({
    authPath,
    modelsJsonPath: join(dir, "models.json"),
  });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux, model: faux.getModel() as Model<Api> };
}

const echoTool: AgentTool = {
  name: "echo",
  description: "Echo the input",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  execute: async (_toolCallId, args) => ({
    content: [{ type: "text", text: `echo: ${(args as { text?: string }).text ?? ""}` }],
    details: { source: "echo" },
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }),
} as unknown as AgentTool;

describe("MikanAgentSession", () => {
  test("runs a prompt, persists messages, and reports the final text", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("hello from faux")]);

    const sessionFile = join(dir, "session.jsonl");
    const sessionStore = SessionStore.create(sessionFile, dir);
    const session = new MikanAgentSession({
      systemPrompt: "You are a test bot.",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore,
    });

    const events: string[] = [];
    session.subscribe((event: HarnessEvent) => {
      events.push(event.type);
    });

    await session.prompt("hi");

    const lastAssistant = session.messages.findLast((message) => message.role === "assistant");
    expect(lastAssistant).toBeDefined();
    expect(JSON.stringify(lastAssistant)).toContain("hello from faux");

    // User + assistant messages are persisted to the session file.
    const persisted = readFileSync(sessionFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string } });
    const roles = persisted
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message?.role);
    expect(roles).toEqual(["user", "assistant"]);

    expect(events).toContain("message_start");
    expect(events).toContain("message_end");
    expect(events).toContain("agent_end");
  });

  test("executes tool calls and persists tool results", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("done"),
    ]);

    const sessionStore = SessionStore.create(join(dir, "session.jsonl"), dir);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore,
    });

    await session.prompt("run the tool");

    const roles = sessionStore
      .getEntries()
      .filter((entry) => entry.type === "message")
      .map((entry) => (entry as { message: { role: string } }).message.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  test("preserves the complete usage breakdown across assistant turns", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("done"),
    ]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore: SessionStore.create(join(dir, "usage.jsonl"), dir),
    });
    session.agent.sessionId = "usage-breakdown";

    await session.prompt("run the tool");

    const stats = session.getLastRunStats();
    expect(stats.usage.cacheRead).toBeGreaterThan(0);
    expect(stats.usage.cacheWrite).toBeGreaterThan(0);
    expect(stats.usage.totalTokens).toBe(
      stats.usage.input + stats.usage.output + stats.usage.cacheRead + stats.usage.cacheWrite,
    );
    expect(stats.tokens).toBe(stats.usage.totalTokens);
    expect(stats.costUsd).toBe(stats.usage.cost.total);
  });

  test("extension tool_call hooks can block tools", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("acknowledged"),
    ]);

    const extensions = new ExtensionRegistry();
    extensions.register("test", "tool_call", ({ toolName }) =>
      toolName === "echo" ? { block: true, reason: "blocked by test" } : undefined,
    );

    const sessionStore = SessionStore.create(join(dir, "session.jsonl"), dir);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore,
    });
    // Reuse the runner with hooks by constructing with extensions.
    const hooked = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore: SessionStore.create(join(dir, "hooked.jsonl"), dir),
      extensions,
    });
    void session;

    await hooked.prompt("run the tool");

    const toolResults = hooked.sessionStore
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "message" &&
          (entry as { message: { role: string } }).message.role === "toolResult",
      );
    expect(JSON.stringify(toolResults)).toContain("blocked by test");
  });

  test("a before_agent_start block stops the turn before the model runs", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("should never be produced")]);

    const extensions = new ExtensionRegistry();
    extensions.register("policy", "before_agent_start", () => ({
      block: true,
      reason: "user not allowed",
    }));

    const sessionStore = SessionStore.create(join(dir, "session.jsonl"), dir);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore,
      extensions,
    });

    const outcome = await session.prompt("do something");
    expect(outcome).toEqual({ blocked: true, reason: "user not allowed" });
    // The model was never called and the blocked turn left no trace.
    expect(session.messages).toHaveLength(0);
    expect(sessionStore.getEntries().filter((entry) => entry.type === "message")).toHaveLength(0);
  });

  test("before_agent_start can rewrite the user prompt and sees the run origin", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("ok")]);

    const seenOrigins: unknown[] = [];
    const extensions = new ExtensionRegistry();
    extensions.register("rewriter", "before_agent_start", ({ prompt, origin }) => {
      seenOrigins.push(origin);
      return { prompt: `${prompt} [enriched]` };
    });

    const sessionStore = SessionStore.create(join(dir, "session.jsonl"), dir);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore,
      extensions,
    });

    const outcome = await session.prompt("original ask", {
      origin: {
        kind: "interactive",
        platform: "slack",
        messageTs: "1700000000.1",
        userId: "U1",
        userName: "kai",
      },
    });
    expect(outcome).toBeUndefined();
    expect(seenOrigins).toEqual([
      {
        kind: "interactive",
        platform: "slack",
        messageTs: "1700000000.1",
        userId: "U1",
        userName: "kai",
      },
    ]);

    // The rewritten prompt is what entered the transcript and the store.
    const userMessage = session.messages.find((message) => message.role === "user");
    expect(JSON.stringify(userMessage)).toContain("original ask [enriched]");
    expect(JSON.stringify(sessionStore.getEntries())).toContain("original ask [enriched]");
  });

  test("system prompt rewrites use and restore each prompt's dynamic base", async () => {
    const { models, faux, model } = createFauxSetup();
    const systemPrompts: string[] = [];
    faux.setResponses([
      (context) => {
        systemPrompts.push(context.systemPrompt);
        return fauxAssistantMessage("first");
      },
      (context) => {
        systemPrompts.push(context.systemPrompt);
        return fauxAssistantMessage("second");
      },
    ]);

    const extensions = new ExtensionRegistry();
    extensions.register("append", "before_agent_start", ({ systemPrompt }) => ({
      systemPrompt: `${systemPrompt}\nrun-only`,
    }));
    const session = new MikanAgentSession({
      systemPrompt: "initial",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: SessionStore.create(join(dir, "session.jsonl"), dir),
      extensions,
    });

    session.agent.state.systemPrompt = "memory-v1";
    await session.prompt("first");
    expect(session.agent.state.systemPrompt).toBe("memory-v1");

    session.agent.state.systemPrompt = "memory-v2";
    await session.prompt("second");
    expect(session.agent.state.systemPrompt).toBe("memory-v2");

    expect(systemPrompts).toEqual(["memory-v1\nrun-only", "memory-v2\nrun-only"]);
  });

  test("origin-conditional system prompt rewrites do not leak into the next prompt", async () => {
    const { models, faux, model } = createFauxSetup();
    const systemPrompts: string[] = [];
    faux.setResponses([
      (context) => {
        systemPrompts.push(context.systemPrompt);
        return fauxAssistantMessage("event response");
      },
      (context) => {
        systemPrompts.push(context.systemPrompt);
        return fauxAssistantMessage("interactive response");
      },
    ]);

    const extensions = new ExtensionRegistry();
    extensions.register("event-policy", "before_agent_start", ({ origin, systemPrompt }) =>
      origin?.kind === "event" ? { systemPrompt: `${systemPrompt}\nevent-only` } : undefined,
    );
    const session = new MikanAgentSession({
      systemPrompt: "base",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: SessionStore.create(join(dir, "session.jsonl"), dir),
      extensions,
    });

    await session.prompt("event", { origin: { kind: "event" } });
    await session.prompt("interactive", { origin: { kind: "interactive" } });

    expect(systemPrompts).toEqual(["base\nevent-only", "base"]);
  });

  test("restores the base system prompt after a provider failure", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      () => {
        throw new Error("provider exploded");
      },
    ]);

    const extensions = new ExtensionRegistry();
    extensions.register("rewrite", "before_agent_start", ({ systemPrompt }) => ({
      systemPrompt: `${systemPrompt}\nrun-only`,
    }));
    const session = new MikanAgentSession({
      systemPrompt: "base",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: SessionStore.create(join(dir, "session.jsonl"), dir),
      extensions,
    });

    await session.prompt("fail");

    expect(session.agent.state.systemPrompt).toBe("base");
  });

  test("context hooks rewrite each LLM call without mutating or persisting the transcript", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("done"),
    ]);

    const extensions = new ExtensionRegistry();
    extensions.register("call-only", "context", ({ messages }) => ({
      messages: messages.map((message) => {
        if (message.role !== "user") return message;
        if (typeof message.content === "string") {
          return { ...message, content: `${message.content} [call-only]` };
        }
        return {
          ...message,
          content: message.content.map((part) =>
            part.type === "text" ? { ...part, text: `${part.text} [call-only]` } : part,
          ),
        };
      }),
    }));

    const sessionStore = SessionStore.create(join(dir, "session.jsonl"), dir);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore,
      extensions,
    });
    const convertedContexts: string[] = [];
    const convertToLlm = session.agent.convertToLlm;
    session.agent.convertToLlm = async (messages) => {
      convertedContexts.push(JSON.stringify(messages));
      return convertToLlm(messages);
    };

    await session.prompt("canonical ask");

    expect(convertedContexts).toHaveLength(2);
    expect(convertedContexts).toEqual([
      expect.stringContaining("canonical ask [call-only]"),
      expect.stringContaining("canonical ask [call-only]"),
    ]);
    expect(convertedContexts[1]).not.toContain("[call-only] [call-only]");
    expect(JSON.stringify(session.messages)).toContain("canonical ask");
    expect(JSON.stringify(session.messages)).not.toContain("[call-only]");
    expect(JSON.stringify(sessionStore.getEntries())).not.toContain("[call-only]");
  });

  test("message_end rewrites reach listeners, persistence, and in-memory state exactly once", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("original answer")]);

    const extensions = new ExtensionRegistry();
    extensions.register("rewrite", "message_end", ({ message }) => {
      if (message.role !== "assistant") return;
      return {
        message: {
          ...message,
          content: message.content.map((part) =>
            part.type === "text"
              ? { ...part, text: part.text.replace("original", "rewritten") }
              : part,
          ),
        },
      };
    });

    const sessionStore = SessionStore.create(join(dir, "session.jsonl"), dir);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore,
      extensions,
    });
    const listenerMessages: string[] = [];
    const persistedCountsAtListener: number[] = [];
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        listenerMessages.push(JSON.stringify(event.message));
        persistedCountsAtListener.push(
          sessionStore
            .getEntries()
            .filter(
              (entry) =>
                entry.type === "message" &&
                (entry as { message: { role: string } }).message.role === "assistant",
            ).length,
        );
      }
    });

    await session.prompt("hi");

    expect(listenerMessages).toEqual([expect.stringContaining("rewritten answer")]);
    expect(persistedCountsAtListener).toEqual([1]);
    const assistantMessages = session.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(JSON.stringify(assistantMessages[0])).toContain("rewritten answer");
    const persistedAssistants = sessionStore
      .getEntries()
      .filter(
        (entry) =>
          entry.type === "message" &&
          (entry as { message: { role: string } }).message.role === "assistant",
      );
    expect(persistedAssistants).toHaveLength(1);
    expect(JSON.stringify(persistedAssistants[0])).toContain("rewritten answer");
    expect(JSON.stringify(persistedAssistants[0])).not.toContain("original answer");
  });

  test("message_end replacements keep the live assistant identity through tool execution and turn_end", async () => {
    const { models, faux, model } = createFauxSetup();
    const originalToolMessage = fauxAssistantMessage(fauxToolCall("echo", { text: "original" }));
    faux.setResponses([originalToolMessage, fauxAssistantMessage("done")]);

    const executedArguments: unknown[] = [];
    const recordingEchoTool: AgentTool = {
      ...echoTool,
      execute: async (_toolCallId, args) => {
        executedArguments.push(args);
        return { content: [{ type: "text", text: "recorded" }], details: {} };
      },
    } as unknown as AgentTool;
    let liveToolMessage: unknown;
    const extensions = new ExtensionRegistry();
    extensions.register("rewrite", "message_end", ({ message }) => {
      if (
        message.role !== "assistant" ||
        !message.content.some((part) => part.type === "toolCall")
      ) {
        return;
      }
      liveToolMessage = message;
      message.errorMessage = "stale optional property";
      const replacement = {
        ...message,
        content: message.content.map((part) =>
          part.type === "toolCall" ? { ...part, arguments: { text: "rewritten" } } : part,
        ),
      };
      delete replacement.errorMessage;
      return { message: replacement };
    });

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [recordingEchoTool],
      models,
      sessionStore: SessionStore.create(join(dir, "identity.jsonl"), dir),
      extensions,
    });
    let messageEndMessage: unknown;
    let turnEndMessage: unknown;
    session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "assistant" &&
        event.message.content.some((part) => part.type === "toolCall")
      ) {
        messageEndMessage = event.message;
      }
      if (
        event.type === "turn_end" &&
        event.message.content.some((part) => part.type === "toolCall")
      ) {
        turnEndMessage = event.message;
      }
    });

    await session.prompt("run the tool");

    expect(executedArguments).toEqual([{ text: "rewritten" }]);
    expect(messageEndMessage).toBe(liveToolMessage);
    expect(turnEndMessage).toBe(liveToolMessage);
    expect(turnEndMessage).toBe(messageEndMessage);
    expect(liveToolMessage).not.toHaveProperty("errorMessage");
    expect(JSON.stringify(turnEndMessage)).toContain('"text":"rewritten"');
    expect(JSON.stringify(turnEndMessage)).not.toContain('"text":"original"');
  });

  test("tool_result hooks rewrite tool output before the model and the store see it", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "token=s3cret" })),
      fauxAssistantMessage("done"),
    ]);

    const originKinds: unknown[] = [];
    const observedDetails: unknown[] = [];
    const observedUsage: unknown[] = [];
    const extensions = new ExtensionRegistry();
    extensions.register("redactor", "tool_result", ({ content, details, origin, usage }) => {
      originKinds.push(origin?.kind);
      observedDetails.push(details);
      observedUsage.push(usage);
      return {
        content: content.map((part) =>
          part.type === "text" ? { ...part, text: part.text.replaceAll("s3cret", "***") } : part,
        ),
        details: { redacted: true },
        usage: usage ? { ...usage, output: usage.output + 1 } : undefined,
      };
    });

    const sessionStore = SessionStore.create(join(dir, "session.jsonl"), dir);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore,
      extensions,
    });

    await session.prompt("run the tool", { origin: { kind: "event", platform: "slack" } });

    expect(originKinds).toEqual(["event"]);
    expect(observedDetails).toEqual([{ source: "echo" }]);
    expect(observedUsage).toEqual([expect.objectContaining({ input: 1, output: 2 })]);
    const persisted = JSON.stringify(
      sessionStore
        .getEntries()
        .filter(
          (entry) =>
            entry.type === "message" &&
            (entry as { message: { role: string } }).message.role === "toolResult",
        ),
    );
    expect(persisted).toContain("echo: token=***");
    expect(persisted).toContain('"redacted":true');
    expect(persisted).not.toContain("s3cret");
  });

  test("agent_error hook fires once when a turn settles on a non-retryable error", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid api key" }),
    ]);

    const errorsSeen: Array<{ errorMessage: string; originKind?: string }> = [];
    const extensions = new ExtensionRegistry();
    extensions.register("monitor", "agent_error", ({ errorMessage, origin }) => {
      errorsSeen.push({ errorMessage, originKind: origin?.kind });
    });

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: SessionStore.create(join(dir, "session.jsonl"), dir),
      extensions,
    });

    await session.prompt("hi", { origin: { kind: "interactive", platform: "slack" } });

    expect(errorsSeen).toEqual([{ errorMessage: "invalid api key", originKind: "interactive" }]);
  });

  test("budget_exceeded hook fires when the circuit breaker trips", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("done"),
    ]);

    const tripped: Array<{ reason: string; llmCalls: number }> = [];
    const extensions = new ExtensionRegistry();
    extensions.register("monitor", "budget_exceeded", ({ reason, llmCalls }) => {
      tripped.push({ reason, llmCalls });
    });

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore: SessionStore.create(join(dir, "session.jsonl"), dir),
      extensions,
    });

    await session.prompt("run the tool", { budget: { maxLlmCalls: 1 } });

    expect(tripped).toHaveLength(1);
    expect(tripped[0].llmCalls).toBe(1);
    expect(tripped[0].reason).toContain("LLM calls");
  });

  test("budget circuit breaker aborts a run that exceeds the LLM-call cap", async () => {
    const { models, faux, model } = createFauxSetup();
    // Would take two LLM calls (tool call, then final); the cap stops it at one.
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "ping" })),
      fauxAssistantMessage("done"),
    ]);

    const sessionStore = SessionStore.create(join(dir, "session.jsonl"), dir);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [echoTool],
      models,
      sessionStore,
    });

    const events: HarnessEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.prompt("run the tool", { budget: { maxLlmCalls: 1 } });

    const budgetEvent = events.find((event) => event.type === "budget_exceeded");
    expect(budgetEvent).toBeDefined();
    if (budgetEvent?.type === "budget_exceeded") {
      expect(budgetEvent.llmCalls).toBe(1);
      expect(budgetEvent.reason).toContain("LLM calls");
    }

    // The cap trips after the first LLM call and aborts the run, so the second
    // turn produces no output — the "done" response never materializes.
    expect(JSON.stringify(sessionStore.getEntries())).not.toContain("done");
  });

  test("foldExternalUsage folds delegated spend and enforces the budget at the fold", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate", {})),
      fauxAssistantMessage("done"),
    ]);

    let session: MikanAgentSession;
    const delegateTool: AgentTool = {
      name: "delegate",
      description: "Simulate a subagent run folding its spend into the parent",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        expect(session.isActiveRun).toBe(true);
        await session.foldExternalUsage({
          input: 1000,
          output: 500,
          cacheRead: 3000,
          cacheWrite: 500,
          cacheWrite1h: 200,
          reasoning: 100,
          totalTokens: 5000,
          cost: {
            input: 0.25,
            output: 0.5,
            cacheRead: 0.25,
            cacheWrite: 0.25,
            total: 1.25,
          },
        });
        return { content: [{ type: "text", text: "delegated" }] };
      },
    } as unknown as AgentTool;
    session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [delegateTool],
      models,
      sessionStore: SessionStore.create(join(dir, "session.jsonl"), dir),
    });

    const events: HarnessEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.prompt("delegate work", { budget: { maxCostUsd: 1 } });

    expect(session.isActiveRun).toBe(false);
    const stats = session.getLastRunStats();
    expect(stats.tokens).toBeGreaterThanOrEqual(5000);
    expect(stats.costUsd).toBeGreaterThanOrEqual(1.25);
    expect(stats.usage).toMatchObject({
      cacheRead: expect.any(Number),
      cacheWrite: expect.any(Number),
      cacheWrite1h: 200,
      reasoning: 100,
    });
    expect(stats.usage.cacheRead).toBeGreaterThanOrEqual(3000);
    expect(stats.usage.cacheWrite).toBeGreaterThanOrEqual(500);
    expect(stats.budgetExceededReason).toContain("cost");
    expect(events.some((event) => event.type === "budget_exceeded")).toBe(true);
    // Enforcement happens at the fold itself: the run aborts before paying
    // for another parent LLM call, so the second response never materializes.
    expect(JSON.stringify(session.messages)).not.toContain("done");
  });

  test("a captured external usage sink cannot contaminate a later prompt", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("capture", {})),
      fauxAssistantMessage("first done"),
      fauxAssistantMessage(fauxToolCall("hold", {})),
      fauxAssistantMessage("second done"),
    ]);

    let session: MikanAgentSession;
    let firstRunSink: ReturnType<MikanAgentSession["captureExternalUsageSink"]> | undefined;
    let releaseSecondRun: (() => void) | undefined;
    let secondRunStarted: (() => void) | undefined;
    const secondRunGate = new Promise<void>((resolve) => {
      releaseSecondRun = resolve;
    });
    const secondRunReady = new Promise<void>((resolve) => {
      secondRunStarted = resolve;
    });
    const captureTool: AgentTool = {
      name: "capture",
      description: "Capture this prompt's external usage sink",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        firstRunSink = session.captureExternalUsageSink();
        return { content: [{ type: "text", text: "captured" }] };
      },
    } as unknown as AgentTool;
    const holdTool: AgentTool = {
      name: "hold",
      description: "Keep the second prompt active",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        secondRunStarted!();
        await secondRunGate;
        return { content: [{ type: "text", text: "released" }] };
      },
    } as unknown as AgentTool;
    session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [captureTool, holdTool],
      models,
      sessionStore: SessionStore.create(join(dir, "usage-owner.jsonl"), dir),
    });

    await session.prompt("capture usage ownership");
    expect(firstRunSink).toBeDefined();

    const secondPrompt = session.prompt("start another run");
    await secondRunReady;
    const secondRunTokens = session.getLastRunStats().tokens;
    await firstRunSink!({
      input: 5000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 5000,
      cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
    });

    expect(session.getLastRunStats().tokens).toBe(secondRunTokens);
    releaseSecondRun!();
    await secondPrompt;
  });

  test("counts compaction completion usage in run stats", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("initial"), fauxAssistantMessage("compacted history")]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: { ...model, contextWindow: 15 },
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: SessionStore.create(join(dir, "compaction-usage.jsonl"), dir),
      settings: { compaction: { reserveTokens: 5, keepRecentTokens: 1 } },
    });

    await session.prompt("history to compact");

    expect(session.getLastRunStats().llmCalls).toBe(2);
    expect(session.getLastRunStats().tokens).toBeGreaterThan(11);
    expect(faux.state.callCount).toBe(2);
  });

  test("compaction usage can trip the token budget", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("initial"), fauxAssistantMessage("compacted history")]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: { ...model, contextWindow: 15 },
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: SessionStore.create(join(dir, "compaction-budget.jsonl"), dir),
      settings: { compaction: { reserveTokens: 5, keepRecentTokens: 1 } },
    });

    await session.prompt("history to compact", { budget: { maxTokens: 20 } });

    expect(session.getLastRunStats().llmCalls).toBe(2);
    expect(session.getLastRunStats().tokens).toBeGreaterThanOrEqual(20);
    expect(session.getLastRunStats().budgetExceededReason).toContain("tokens");
  });

  test("overflow recovery does not retry after compaction exceeds the token budget", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "context length exceeded",
      }),
      fauxAssistantMessage("compacted history"),
      fauxAssistantMessage("retry must not run"),
    ]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: { ...model, contextWindow: 100 },
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: SessionStore.create(join(dir, "overflow-budget.jsonl"), dir),
      settings: { compaction: { reserveTokens: 50, keepRecentTokens: 1 } },
    });

    await session.prompt("history to compact", { budget: { maxTokens: 20 } });

    expect(session.getLastRunStats().llmCalls).toBe(2);
    expect(session.getLastRunStats().tokens).toBeGreaterThanOrEqual(20);
    expect(session.getLastRunStats().budgetExceededReason).toContain("tokens");
    expect(faux.state.callCount).toBe(2);
    expect(JSON.stringify(session.messages)).not.toContain("retry must not run");
  });

  test("a compaction completion does not start at the LLM-call cap", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage("initial"),
      fauxAssistantMessage("compaction must not run"),
    ]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: { ...model, contextWindow: 15 },
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: SessionStore.create(join(dir, "compaction-call-cap.jsonl"), dir),
      settings: { compaction: { reserveTokens: 5, keepRecentTokens: 1 } },
    });

    await session.prompt("history to compact", { budget: { maxLlmCalls: 1 } });

    expect(session.getLastRunStats()).toMatchObject({ llmCalls: 1 });
    expect(session.getLastRunStats().budgetExceededReason).toContain("LLM calls");
    expect(faux.state.callCount).toBe(1);
  });

  test("a final response at the LLM-call cap completes without tripping the budget", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([fauxAssistantMessage("done in one")]);

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: SessionStore.create(join(dir, "session.jsonl"), dir),
    });

    await session.prompt("answer directly", { budget: { maxLlmCalls: 1 } });

    expect(session.getLastRunStats()).toMatchObject({ llmCalls: 1 });
    expect(session.getLastRunStats().budgetExceededReason).toBeUndefined();
    expect(JSON.stringify(session.messages)).toContain("done in one");
  });

  test("throws a clear error when provider auth is missing", async () => {
    // Custom provider with no key configured anywhere: auth resolution fails.
    const modelsJsonPath = join(dir, "models.json");
    writeFileSync(
      modelsJsonPath,
      JSON.stringify({
        providers: {
          "keyless-provider": {
            api: "openai-completions",
            baseUrl: "http://localhost:1/v1",
            models: [{ id: "m1", name: "M1", input: ["text"], reasoning: false }],
          },
        },
      }),
    );
    const models = MikanModels.create({ authPath: join(dir, "auth.json"), modelsJsonPath });
    const model = models.find("keyless-provider", "m1");
    expect(model).toBeDefined();

    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: model!,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: SessionStore.create(join(dir, "session.jsonl"), dir),
    });

    await expect(session.prompt("hi")).rejects.toThrow(/No credentials for provider/);
  });
});
