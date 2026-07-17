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
} from "../src/harness/index.js";

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

  test("tool_result hooks rewrite tool output before the model and the store see it", async () => {
    const { models, faux, model } = createFauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { text: "token=s3cret" })),
      fauxAssistantMessage("done"),
    ]);

    const originKinds: unknown[] = [];
    const extensions = new ExtensionRegistry();
    extensions.register("redactor", "tool_result", ({ content, origin }) => {
      originKinds.push(origin?.kind);
      return {
        content: content.map((part) =>
          part.type === "text" ? { ...part, text: part.text.replaceAll("s3cret", "***") } : part,
        ),
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
