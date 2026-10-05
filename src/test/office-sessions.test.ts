import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type {
  Api,
  Context,
  Model,
  MutableModels,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GenerationTask, ProviderDoc, defineExtension, hook } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { SessionStore } from "../sessions/session-store.js";

let dir: string;
let office: Office;
const stores: SessionStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-office-sessions-"));
  office = createWorkspace({ root: join(dir, "workspace"), stateDir: join(dir, "state") }).office(
    createOfficeAddress("slack", "C1"),
  );
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const session = async (key: string, budget?: { maxLlmCalls: number }) => {
    const store = await SessionStore.open(office, key);
    stores.push(store);
    return new MikanAgentSession({
      model,
      models,
      sessionStore: store,
      tools: [],
      thinkingLevel: "off",
      systemPrompt: `prompt for ${key}`,
      settings: { compaction: { enabled: false }, budget },
    });
  };
  return { faux, session };
}

function lastUserText(context: Context): string {
  return JSON.stringify(context.messages.findLast((message) => message.role === "user"));
}

test("each concurrent session's requests carry its own session id and budget", async () => {
  const { faux, session } = setup();
  const channel = await session("C1");
  const thread = await session("C1:1000.1", { maxLlmCalls: 0 });
  const seen: Array<{ prompt: string; sessionId: string | undefined }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  faux.setResponses(
    Array.from({ length: 4 }, () => async (context: Context, options?: SimpleStreamOptions) => {
      seen.push({ prompt: lastUserText(context), sessionId: options?.sessionId });
      await gate;
      return fauxAssistantMessage("ok");
    }),
  );

  const runs = Promise.all([channel.prompt("from channel"), thread.prompt("from thread")]);
  release();
  await runs;

  expect(seen).toEqual([
    {
      prompt: expect.stringContaining("from channel"),
      sessionId: expect.any(String),
    },
  ]);
  expect(seen[0]?.sessionId).not.toBe(channel.sessionStore.getSessionId());
  expect(thread.getLastRunStats().budgetExceededReason).toContain("LLM calls");
});

test("opening an office aborts a session's unfinished run before another session submits", async () => {
  const { faux, session } = setup();
  const thread = await session("C1:1000.1");
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  faux.setResponses([
    async (_context: Context, options?: SimpleStreamOptions) => {
      markStarted();
      await new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("closed")));
      });
      return fauxAssistantMessage("never");
    },
  ]);
  const interrupted = thread.prompt("interrupted thread work").catch(() => undefined);
  await started;
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await interrupted;

  const prompts: string[] = [];
  faux.setResponses(
    Array.from({ length: 3 }, () => (context: Context) => {
      prompts.push(lastUserText(context));
      return fauxAssistantMessage("answer");
    }),
  );
  await (await session("C1")).prompt("channel question");

  expect(prompts).toEqual([expect.stringContaining("channel question")]);
  expect(await SessionStore.inspectExecution(office, "C1:1000.1")).toMatchObject({ open: false });
});

test("a message steered into a running session reaches its next request", async () => {
  const { faux } = setup();
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  (models.models as MutableModels).setProvider(faux.provider);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const toolStarted = new Promise<void>((resolve) => (started = resolve));
  const slow = {
    name: "slow",
    label: "slow",
    description: "Waits",
    parameters: Type.Object({ label: Type.String() }),
    execute: async () => {
      started();
      await gate;
      return { content: [{ type: "text" as const, text: "slow done" }], details: undefined };
    },
  };
  const store = await SessionStore.open(office, "D1:1000.1");
  stores.push(store);
  const session = new MikanAgentSession({
    model: faux.getModel() as Model<Api>,
    models,
    sessionStore: store,
    tools: [slow],
    thinkingLevel: "off",
    systemPrompt: "p",
    settings: { compaction: { enabled: false } },
  });
  const requests: string[] = [];
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("slow", { label: "wait" }), { stopReason: "toolUse" }),
    (context: Context) => {
      requests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("final");
    },
  ]);
  const run = session.prompt("start the task");
  await toolStarted;
  expect(await session.steer("also add CODE_42")).toBe(true);
  release();
  await run;

  expect(requests[0]).toContain("CODE_42");
});

test("native identity routes cloned generation and compaction requests to their own models", async () => {
  const context = BACKGROUND_CONTEXT;
  const seen: Array<{ owner: string; sessionId: string | undefined }> = [];
  const attach = async (key: string) => {
    const store = await SessionStore.open(office, key);
    stores.push(store);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses(
      Array.from({ length: 8 }, () => (_request: Context, options?: SimpleStreamOptions) => {
        seen.push({ owner: key, sessionId: options?.sessionId });
        return fauxAssistantMessage(`answer from ${key}`);
      }),
    );
    const attached = await store.bindHarness({
      models,
      settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
    });
    const extension = defineExtension({
      name: attached.extensionName,
      hooks: [
        hook(GenerationTask, {
          beforeRequest: (request) => ({ messages: structuredClone(request.messages) }),
        }),
      ],
    });
    attached.registry.install(extension);
    const model = faux.getModel();
    await attached.conversation.configure(
      { model: { provider: model.provider, modelId: model.id }, extensions: [extension] },
      context,
    );
    return attached;
  };
  const channel = await attach("C1");
  const thread = await attach("C1:1000.1");
  const prompts = await Promise.all([
    channel.conversation.submit({ type: "input", content: "channel" }, context),
    thread.conversation.submit({ type: "input", content: "thread" }, context),
  ]);
  await Promise.all(prompts.map((prompt) => prompt.wait(context)));
  await (
    await channel.conversation.submit({ type: "input", content: "channel follow-up" }, context)
  ).wait(context);
  const compact = await channel.conversation.compact(undefined, context);
  expect((await channel.harness.waitForTask(compact, context)).state.outcome.status).toBe(
    "completed",
  );
  const channelId = (await channel.harness.snapshot(ProviderDoc, channel.conversation.id, context))
    ?.sessionId;
  const threadId = (await thread.harness.snapshot(ProviderDoc, thread.conversation.id, context))
    ?.sessionId;
  expect(channelId).toEqual(expect.any(String));
  expect(threadId).toEqual(expect.any(String));
  expect(channelId).not.toBe(threadId);
  expect(seen).toEqual(
    expect.arrayContaining([
      { owner: "C1", sessionId: channelId },
      { owner: "C1:1000.1", sessionId: threadId },
    ]),
  );
  expect(seen.filter((request) => request.owner === "C1")).toHaveLength(3);
  expect(
    seen.every((request) => request.sessionId === (request.owner === "C1" ? channelId : threadId)),
  ).toBe(true);
});

test("binding backfills native identity once and preserves it across reset and reopen", async () => {
  const context = BACKGROUND_CONTEXT;
  const models = createModels();
  const store = await SessionStore.open(office, "C1");
  stores.push(store);
  const seed = await store.bindHarness({ models });
  await seed.harness.commit((tx) => tx.retireDoc(ProviderDoc, seed.conversation.id), context);
  expect(await seed.harness.snapshot(ProviderDoc, seed.conversation.id, context)).toBeUndefined();
  await store.close();
  const legacy = await SessionStore.open(office, "C1");
  stores.push(legacy);
  const attached = await legacy.bindHarness({ models });
  const before = await attached.harness.snapshot(ProviderDoc, attached.conversation.id, context);
  expect(before?.sessionId).toEqual(expect.any(String));
  await legacy.reset();
  expect(await attached.harness.snapshot(ProviderDoc, attached.conversation.id, context)).toEqual(
    before,
  );
  await legacy.close();
  const reopened = await SessionStore.open(office, "C1");
  stores.push(reopened);
  const rebound = await reopened.bindHarness({ models });
  expect(await rebound.harness.snapshot(ProviderDoc, rebound.conversation.id, context)).toEqual(
    before,
  );
});
