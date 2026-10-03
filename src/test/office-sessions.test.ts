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
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
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
      sessionId: channel.sessionStore.getSessionId(),
    },
  ]);
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
