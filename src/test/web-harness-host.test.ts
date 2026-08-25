import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HarnessCommandResult,
  HarnessEventEnvelope,
  HarnessPrincipal,
} from "@geminixiang/mikan-harness-web-contract";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createGlobalSettingsFile } from "../config.js";
import type { ConversationRuntime } from "../runtime/types.js";
import { MikanModels } from "../harness/index.js";
import { createWorkspace } from "../office/index.js";
import { HarnessHostError, MikanHarnessHost } from "../web/harness/host.js";

const principal: HarnessPrincipal = { id: "github:101", displayName: "octo" };
const outsider: HarnessPrincipal = { id: "github:202", displayName: "other" };
let root: string;
let stateDir: string;
let previousStateDir: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mikan-web-host-"));
  stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  createGlobalSettingsFile(stateDir);
  previousStateDir = process.env.MIKAN_STATE_DIR;
  process.env.MIKAN_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.MIKAN_STATE_DIR;
  else process.env.MIKAN_STATE_DIR = previousStateDir;
  rmSync(root, { recursive: true, force: true });
});

describe("MikanHarnessHost", () => {
  test("owns the complete create, prompt, cancel, and model flow", async () => {
    const workspace = createWorkspace({ root: join(root, "workspace"), stateDir });
    const controlled = createControlledRuntime();
    const host = new MikanHarnessHost({
      workspace,
      stateDir,
      runtime: controlled.runtime,
      models: createModels(root),
    });

    const empty = await host.bootstrap(principal);
    expect(empty.conversations).toEqual([]);
    expect(empty.models).toContainEqual(
      expect.objectContaining({ provider: "test-provider", id: "model-a" }),
    );

    const createCommand = { kind: "create-conversation" as const, commandId: "create-1" };
    const created = expectCreated(await host.execute(principal, createCommand));
    const repeated = expectCreated(await host.execute(principal, createCommand));
    expect(repeated.officeKey).toBe(created.officeKey);
    expect(created.transcript).toEqual([]);
    expect(created.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const opened = await host.bootstrap(principal, created.officeKey);
    expect(opened.conversation?.officeKey).toBe(created.officeKey);
    expect(opened.conversation?.sessionId).toBe(created.sessionId);
    await expect(host.bootstrap(outsider, created.officeKey)).rejects.toMatchObject({
      code: "not-found",
    });

    const envelopes: HarnessEventEnvelope[] = [];
    const subscription = host.subscribe(principal, opened.cursor, (event) => envelopes.push(event));
    expect(subscription.kind).toBe("subscribed");

    await expect(
      host.execute(principal, {
        kind: "prompt",
        commandId: "prompt-stale",
        officeKey: created.officeKey,
        sessionId: "stale-session",
        text: "hello",
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const accepted = await host.execute(principal, {
      kind: "prompt",
      commandId: "prompt-1",
      officeKey: created.officeKey,
      sessionId: created.sessionId,
      text: "Explain the architecture",
    });
    expect(accepted.kind).toBe("prompt-accepted");
    const runId = accepted.kind === "prompt-accepted" ? accepted.runId : "";
    expect((await host.bootstrap(principal, created.officeKey)).conversation?.run?.id).toBe(runId);

    await expect(
      host.execute(principal, {
        kind: "cancel-run",
        commandId: "cancel-stale",
        officeKey: created.officeKey,
        sessionId: created.sessionId,
        runId: "another-run",
      }),
    ).rejects.toBeInstanceOf(HarnessHostError);

    await host.execute(principal, {
      kind: "cancel-run",
      commandId: "cancel-1",
      officeKey: created.officeKey,
      sessionId: created.sessionId,
      runId,
    });
    await vi.waitFor(async () => {
      expect(
        (await host.bootstrap(principal, created.officeKey)).conversation?.run,
      ).toBeUndefined();
    });
    expect(envelopes.map((entry) => entry.event.kind)).toContain("run.finished");

    const updated = await host.execute(principal, {
      kind: "set-model",
      commandId: "model-1",
      officeKey: created.officeKey,
      sessionId: created.sessionId,
      provider: "test-provider",
      model: "model-a",
      thinkingLevel: "high",
    });
    expect(updated).toMatchObject({
      kind: "model-updated",
      conversation: {
        model: { provider: "test-provider", model: "model-a", thinkingLevel: "high" },
      },
    });
    if (subscription.kind === "subscribed") subscription.dispose();
  });
});

function createControlledRuntime(): { runtime: ConversationRuntime } {
  let finishRun: (() => void) | undefined;
  const runtime: ConversationRuntime = {
    isRunning: () => finishRun !== undefined,
    getRunningSessions: () => [],
    async handleEvent(_event, _bot, context) {
      // Runner admission deliberately happens after prompt acknowledgement;
      // exact-run cancellation must keep retrying until runtime state exists.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await context.responder.appendResponseDelta?.("Hello");
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      finishRun = undefined;
      await context.responder.finishResponse?.("Hello from mikan");
    },
    async handleStop() {},
    forceStop() {
      finishRun?.();
    },
    async handleNewCommand() {},
    async handleExtensionAction() {
      return false;
    },
    async handleExtensionScheduleCallback() {
      return false;
    },
    async runSession({ event, bot, context }) {
      await runtime.handleEvent(event, bot, context);
    },
    switchConversationModel: () => true,
    refreshConversationEnvironment: () => true,
    refreshAllConversations: () => ({ busy: [] }),
    async shutdown() {},
  };
  return { runtime };
}

function createModels(dir: string): MikanModels {
  const modelsJsonPath = join(dir, "models.json");
  writeFileSync(
    modelsJsonPath,
    JSON.stringify({
      providers: {
        "test-provider": {
          api: "openai-completions",
          apiKey: "test-key",
          baseUrl: "http://127.0.0.1:1/v1",
          models: [{ id: "model-a", name: "Model A", input: ["text"], reasoning: true }],
        },
      },
    }),
  );
  return MikanModels.create({ authPath: join(dir, "auth.json"), modelsJsonPath });
}

function expectCreated(result: HarnessCommandResult) {
  if (result.kind !== "conversation-created") throw new Error("Expected conversation-created");
  return result.conversation;
}
