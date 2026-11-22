import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Model, MutableModels, TranscriptContext } from "@earendil-works/pi-ai";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import { createSubagentTool } from "../harness/tools/subagent.js";
import type { MikanToolContext } from "../harness/types.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { MAX_OWNED_CONVERSATIONS, SessionStore } from "../sessions/session-store.js";

const KEY = "C123";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-subagent-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  const office: Office = createWorkspace({
    root: join(dir, "workspace"),
    stateDir: join(dir, "state"),
  }).office(createOfficeAddress("slack", KEY));
  const wrap = (store: SessionStore) => {
    const toolContext: MikanToolContext = { env: () => undefined };
    const session = new MikanAgentSession({
      model: faux.getModel() as Model<Api>,
      models,
      sessionStore: store,
      tools: [createSubagentTool(toolContext)],
      toolContext,
      thinkingLevel: "off",
      systemPrompt: "parent prompt",
      settings: { compaction: { enabled: false } },
    });
    toolContext.subagents = session.subagentHost();
    return session;
  };
  return { faux, office, wrap };
}

const delegate = (...tasks: string[]) =>
  fauxAssistantMessage(
    tasks.map((task) => fauxToolCall("subagent", { label: task, task })),
    { stopReason: "toolUse" },
  );

const toolResults = (context: TranscriptContext) =>
  context.messages.filter((message) => message.role === "toolResult").map((m) => JSON.stringify(m));

test("the child gets the parent's prompt, the task alone, and returns its answer with its spend", async () => {
  const { faux, office, wrap } = setup();
  const store = await SessionStore.open(office, KEY);
  let child = "";
  let parent: string[] = [];
  faux.setResponses([
    delegate("count the files"),
    (context) => {
      child = JSON.stringify(context.messages);
      return fauxAssistantMessage("forty-two files");
    },
    (context) => ((parent = toolResults(context)), fauxAssistantMessage("done")),
  ]);
  const session = wrap(store);

  await session.prompt("how many files are there?");
  const usage = session.getLastRunStats().usage;
  await store.close();

  expect(child).toContain("parent prompt");
  expect(child).toContain("You are a subagent");
  expect(child).toContain("count the files");
  expect(child).not.toContain("how many files are there?");
  expect(parent).toHaveLength(1);
  expect(parent[0]).toContain("forty-two files");
  expect(faux.state.callCount).toBe(3);
  expect(usage.output).toBeGreaterThanOrEqual(3 * 2);
  expect((await SessionStore.list(office)).map((listed) => listed.key)).toEqual([KEY]);
});

test("a child cannot delegate", async () => {
  const { faux, office, wrap } = setup();
  const store = await SessionStore.open(office, KEY);
  let child: string[] = [];
  faux.setResponses([
    delegate("outer"),
    delegate("inner"),
    (context) => ((child = toolResults(context)), fauxAssistantMessage("child done")),
    fauxAssistantMessage("done"),
  ]);

  await wrap(store).prompt("delegate");
  await store.close();

  expect(child).toHaveLength(1);
  expect(child[0]).toContain("Tool subagent is not available");
  expect(faux.state.callCount).toBe(4);
});

test("an office runs a bounded number of children at once and the rest wait", async () => {
  const { faux, office, wrap } = setup();
  const store = await SessionStore.open(office, KEY);
  const tasks = Array.from({ length: MAX_OWNED_CONVERSATIONS + 2 }, (_, index) => `task ${index}`);
  let running = 0;
  let peak = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const child = async () => {
    running += 1;
    peak = Math.max(peak, running);
    await gate;
    running -= 1;
    return fauxAssistantMessage("ok");
  };
  let parent: string[] = [];
  faux.setResponses([
    delegate(...tasks),
    ...tasks.map(() => child),
    (context) => ((parent = toolResults(context)), fauxAssistantMessage("done")),
  ]);

  const run = wrap(store).prompt("fan out");
  await vi.waitFor(() => expect(running).toBe(MAX_OWNED_CONVERSATIONS));
  open();
  await run;
  await store.close();

  expect(peak).toBe(MAX_OWNED_CONVERSATIONS);
  expect(parent).toHaveLength(tasks.length);
});

test("aborting the run ends the child without another model call", async () => {
  const { faux, office, wrap } = setup();
  const store = await SessionStore.open(office, KEY);
  let childStarted!: () => void;
  const started = new Promise<void>((resolve) => (childStarted = resolve));
  faux.setResponses([
    delegate("long job"),
    async (_context, options) => {
      childStarted();
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return fauxAssistantMessage("late");
    },
    fauxAssistantMessage("must not be requested"),
  ]);
  const session = wrap(store);

  const run = session.prompt("start").catch(() => undefined);
  await started;
  await session.abort();
  await run;
  await store.close();

  expect(faux.state.callCount).toBe(2);
  expect(session.getLastRunStats().status).toBe("aborted");
});

test("a run interrupted while its child works resumes the same child once", async () => {
  const { faux, office, wrap } = setup();
  const first = await SessionStore.open(office, KEY);
  let childStarted!: () => void;
  const started = new Promise<void>((resolve) => (childStarted = resolve));
  faux.setResponses([
    delegate("long job"),
    async (_context, options) => {
      childStarted();
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return fauxAssistantMessage("lost with the process");
    },
  ]);
  const interrupted = wrap(first)
    .prompt("start")
    .catch(() => undefined);
  await started;
  await first.close();
  await interrupted;

  expect(await SessionStore.continueInterrupted(office)).toEqual([KEY]);
  const store = await SessionStore.open(office, KEY);
  const childRequests: string[] = [];
  let parent: string[] = [];
  faux.setResponses([
    (context) => {
      childRequests.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("answer after the restart");
    },
    (context) => ((parent = toolResults(context)), fauxAssistantMessage("done")),
  ]);
  const session = wrap(store);
  await session.continueInterrupted();
  await store.close();

  expect(childRequests).toHaveLength(1);
  expect(childRequests[0]?.match(/long job/g)).toHaveLength(1);
  expect(parent).toHaveLength(1);
  expect(parent[0]).toContain("answer after the restart");
  expect(session.getLastRunStats().status).toBe("completed");
});
