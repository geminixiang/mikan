import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import type { ConversationMessage, ConversationResponder, MessagingInfo } from "../src/adapter.js";
import { createRunner } from "../src/agent.js";
import { MikanAgentSession, MikanModels } from "../src/harness/index.js";
import { createManagedSessionFile, getChannelSessionDir } from "../src/sessions/store.js";

/**
 * Drives PiAgentWrapper.run() end to end with a faux provider: the runner is
 * built by the real createRunner (host sandbox, no vault/provisioner) and the
 * scripted responder observes the run-lifecycle behaviour that previously had
 * no test through this interface — final replacement, [SILENT], error
 * finalize, and run-state reset between runs.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-agent-runner-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({ llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" } }),
  );
  process.env.MIKAN_STATE_DIR = stateDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MIKAN_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function createFauxModels(): { models: MikanModels; faux: ReturnType<typeof fauxProvider> } {
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ faux: { type: "api_key", key: "test-key" } }));
  const models = MikanModels.create({
    authPath,
    modelsJsonPath: join(dir, "models.json"),
  });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux };
}

async function createTestRunner() {
  const { models, faux } = createFauxModels();
  const workspaceDir = join(dir, "workspace");
  const conversationDir = join(workspaceDir, "C1");
  mkdirSync(conversationDir, { recursive: true });
  const sessionDir = getChannelSessionDir(conversationDir);
  const contextFile = createManagedSessionFile(sessionDir, conversationDir);

  const runner = await createRunner({
    sandboxConfig: { type: "host" },
    sessionKey: "C1",
    conversationId: "C1",
    conversationDir,
    workspaceDir,
    sessionScope: { sessionDir, contextFile, threadRootMessage: null },
    models,
  });
  return { runner, faux };
}

function makeResponder(): ConversationResponder & {
  replaceResponse: ReturnType<typeof vi.fn>;
  respondDiagnostic: ReturnType<typeof vi.fn>;
  deleteResponse: ReturnType<typeof vi.fn>;
} {
  return {
    respond: vi.fn().mockResolvedValue(undefined),
    replaceResponse: vi.fn().mockResolvedValue(undefined),
    respondDiagnostic: vi.fn().mockResolvedValue(undefined),
    respondToolResult: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    setWorking: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    deleteResponse: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "1000.1",
    sessionKey: "C1",
    conversationKind: "shared",
    userId: "U1",
    userName: "alice",
    text: "hi",
    attachments: [],
    ...overrides,
  };
}

const platform: MessagingInfo = {
  name: "chat",
  formattingGuide: "",
  channels: [],
  users: [],
  trustModel: "membership",
};

describe("PiAgentWrapper.run", () => {
  test("surfaces subagent batch progress through the platform-neutral responder", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("subagent", {
          tasks: [
            { label: "first", task: "first task" },
            { label: "second", task: "second task" },
          ],
        }),
      ),
      fauxAssistantMessage("first result"),
      fauxAssistantMessage("second result"),
      fauxAssistantMessage("parent complete"),
    ]);
    const responder = makeResponder();

    await runner.run(makeMessage({ text: "delegate twice" }), responder, platform);

    const replacements = responder.replaceResponse.mock.calls.map((call) => String(call[0]));
    expect(replacements.some((text) => text.includes("Subagent parallel 2/2"))).toBe(true);
    expect(replacements.some((text) => text.includes("✓ first") && text.includes("✓ second"))).toBe(
      true,
    );
    expect(replacements.at(-1)).toContain("parent complete");
  });

  test("replaces the placeholder with the final assistant text", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([fauxAssistantMessage("hello from the agent")]);
    const responder = makeResponder();

    const result = await runner.run(makeMessage(), responder, platform);

    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(responder.replaceResponse).toHaveBeenCalledTimes(1);
    expect(responder.replaceResponse.mock.calls[0]?.[0]).toContain("hello from the agent");
    expect(responder.deleteResponse).not.toHaveBeenCalled();
    expect(runner.getCurrentStep()).toBeUndefined();
  });

  test("[SILENT] responses delete the placeholder instead of replacing it", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([fauxAssistantMessage("[SILENT]")]);
    const responder = makeResponder();

    const result = await runner.run(makeMessage(), responder, platform);

    expect(result.stopReason).toBe("stop");
    expect(responder.deleteResponse).toHaveBeenCalledTimes(1);
    expect(responder.replaceResponse).not.toHaveBeenCalled();
  });

  test("error stop reasons surface an apology and a diagnostic", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }),
    ]);
    const responder = makeResponder();

    const result = await runner.run(makeMessage(), responder, platform);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("provider exploded");
    expect(responder.replaceResponse).toHaveBeenCalledWith("_Sorry, something went wrong_");
    expect(responder.respondDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("provider exploded"),
      { style: "error" },
    );
  });

  test("run state resets between runs on the same runner", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "first run failed" }),
      fauxAssistantMessage("second run ok"),
    ]);

    const first = await runner.run(makeMessage({ id: "1000.1" }), makeResponder(), platform);
    expect(first.stopReason).toBe("error");

    const secondResponder = makeResponder();
    const second = await runner.run(makeMessage({ id: "1000.2" }), secondResponder, platform);

    expect(second.stopReason).toBe("stop");
    expect(second.errorMessage).toBeUndefined();
    expect(secondResponder.replaceResponse.mock.calls[0]?.[0]).toContain("second run ok");
    expect(secondResponder.respondDiagnostic).not.toHaveBeenCalled();
  });

  test("hidden memory maintenance sees the old transcript and writes memory", async () => {
    const promptSpy = vi.spyOn(MikanAgentSession.prototype, "prompt");
    const { runner, faux } = await createTestRunner();
    const memoryPath = join(dir, "workspace", "C1", "MEMORY.md");
    const setupResponder = makeResponder();
    let maintenancePrompt = "";
    faux.setResponses([
      fauxAssistantMessage("recorded old turn"),
      (context) => {
        const messages = JSON.stringify(context.messages);
        expect(messages).toContain("durable launch decision");
        maintenancePrompt = messages;
        return fauxAssistantMessage(
          fauxToolCall("write", {
            label: "preserve memory",
            path: memoryPath,
            content: "Launch decision: use the staged rollout.",
          }),
        );
      },
      fauxAssistantMessage("memory updated"),
    ]);
    await runner.run(
      makeMessage({ text: "durable launch decision: use a staged rollout" }),
      setupResponder,
      platform,
    );
    const visibleCallsBeforeMaintenance = setupResponder.replaceResponse.mock.calls.length;

    const result = await runner.maintainMemory(
      makeMessage({ id: "memory:C1", conversationKind: "direct", text: "/new" }),
      platform,
    );

    expect(result).toEqual({ stopReason: "stop", errorMessage: undefined });
    expect(maintenancePrompt).toContain("preserve only durable information");
    expect(maintenancePrompt).toContain("Preserve the concrete values and details needed");
    expect(maintenancePrompt).toContain("exact content is worth preserving");
    expect(promptSpy.mock.calls.at(-1)?.[1]).toMatchObject({
      budget: { maxDurationMs: 120_000, maxLlmCalls: 5, maxCostUsd: 0.25 },
    });
    expect(setupResponder.replaceResponse).toHaveBeenCalledTimes(visibleCallsBeforeMaintenance);
    expect(readFileSync(memoryPath, "utf-8")).toBe("Launch decision: use the staged rollout.");
  });

  test("empty final text leaves the placeholder untouched", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([fauxAssistantMessage("")]);
    const responder = makeResponder();

    const result = await runner.run(makeMessage(), responder, platform);

    expect(result.stopReason).toBe("stop");
    expect(responder.replaceResponse).not.toHaveBeenCalled();
    expect(responder.deleteResponse).not.toHaveBeenCalled();
  });
});
