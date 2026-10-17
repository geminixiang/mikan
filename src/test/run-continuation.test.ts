import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model, MutableModels } from "@earendil-works/pi-ai";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import { tagHarnessTool } from "../harness/tools/pi-tools.js";
import type { MikanHarnessTool } from "../harness/types.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { SessionStore } from "../sessions/session-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-run-continuation-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const office: Office = createWorkspace({
    root: join(dir, "workspace"),
    stateDir: join(dir, "state"),
  }).office(createOfficeAddress("slack", "C123"));
  const started: Array<() => void> = [];
  const toolStarted = () => new Promise<void>((resolve) => started.push(resolve));
  const slow: AgentTool = {
    name: "slow",
    label: "slow",
    description: "Runs until aborted",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      started.shift()?.();
      await new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
      return { content: [{ type: "text", text: "never" }], details: undefined };
    },
  };
  const delegate: MikanHarnessTool = tagHarnessTool({
    name: "delegate",
    description: "Runs a task in a child conversation owned by this call",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, callContext) => {
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        return (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } }))
          .id;
      }, callContext);
      const handle = await api.conversation(child, callContext);
      const request = {
        type: "input",
        content: "child work",
        requestId: `delegate:${api.taskId}`,
      } as const;
      const settled = await (await handle!.submit(request, callContext)).wait(callContext);
      if (settled.status !== "done" || settled.type !== "input") {
        return { output: [{ type: "text", text: `child ${settled.status}` }] };
      }
      const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), callContext);
      const message = entry?.model?.[0] as AssistantMessage | undefined;
      const text = message?.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      return { output: [{ type: "text", text: `child said ${text}` }] };
    },
  });
  const wrap = (store: SessionStore) =>
    new MikanAgentSession({
      model,
      models,
      sessionStore: store,
      tools: [slow, delegate],
      thinkingLevel: "off",
      systemPrompt: "prompt",
      settings: { compaction: { enabled: false } },
    });
  return { faux, office, toolStarted, wrap };
}

async function interrupt(env: ReturnType<typeof setup>, keys: readonly string[]): Promise<void> {
  const { faux, office, toolStarted } = env;
  const stores = await Promise.all(keys.map((key) => SessionStore.open(office, key)));
  faux.setResponses(
    keys.map(() => fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" })),
  );
  const runs = stores.map(async (store) => {
    const running = toolStarted();
    const run = env
      .wrap(store)
      .prompt("long work")
      .catch(() => undefined);
    await running;
    return { run };
  });
  const pending = await Promise.all(runs);
  await Promise.all(stores.map((store) => store.close()));
  await Promise.all(pending.map(({ run }) => run));
}

test("a run interrupted by a close continues in the same turn after reopening", async () => {
  const env = setup();
  await interrupt(env, ["C123:1.000001"]);

  expect(await SessionStore.continueInterrupted(env.office)).toEqual(["C123:1.000001"]);
  const store = await SessionStore.open(env.office, "C123:1.000001");
  let seen = "";
  env.faux.setResponses([
    (context) => {
      seen = JSON.stringify(context.messages);
      return fauxAssistantMessage("finished after the restart");
    },
  ]);
  const session = env.wrap(store);
  await session.continueInterrupted();
  await store.close();

  expect(seen).toContain("Tool slow was interrupted");
  expect(seen).not.toContain("Tool slow was aborted");
  expect(seen.match(/long work/g)).toHaveLength(1);
  expect(session.getLastRunStats().status).toBe("completed");
  expect((await SessionStore.inspectExecution(env.office, "C123:1.000001")).open).toBe(false);
});

test("every interrupted run of an office continues, even when another session sends first", async () => {
  const env = setup();
  await interrupt(env, ["C123:1.000001", "C123:2.000002"]);

  expect((await SessionStore.continueInterrupted(env.office)).toSorted()).toEqual([
    "C123:1.000001",
    "C123:2.000002",
  ]);
  const callsBefore = env.faux.state.callCount;
  env.faux.setResponses([
    fauxAssistantMessage("answer"),
    fauxAssistantMessage("answer"),
    fauxAssistantMessage("answer"),
  ]);
  const other = await SessionStore.open(env.office, "C123:3.000003");
  const first = await SessionStore.open(env.office, "C123:1.000001");
  const second = await SessionStore.open(env.office, "C123:2.000002");
  const otherRun = env.wrap(other).prompt("a new message elsewhere");
  const seen = await Promise.all(
    [first, second].map(async (store) => {
      const session = env.wrap(store);
      const answers: string[] = [];
      session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          answers.push(JSON.stringify(event.message.content));
        }
      });
      await session.continueInterrupted();
      return answers.join("");
    }),
  );
  await otherRun;
  await Promise.all([other, first, second].map((store) => store.close()));

  expect(seen).toEqual([expect.stringContaining("answer"), expect.stringContaining("answer")]);
  expect(env.faux.state.callCount - callsBefore).toBe(3);
});

test("other sessions of an office wait to start until every interrupted run is bound", async () => {
  const env = setup();
  await interrupt(env, ["C123:1.000001", "C123:2.000002"]);
  await SessionStore.continueInterrupted(env.office);
  const other = await SessionStore.open(env.office, "C123:3.000003");
  const first = await SessionStore.open(env.office, "C123:1.000001");
  const second = await SessionStore.open(env.office, "C123:2.000002");
  let started = false;
  const waiting = other.whenContinued().then(() => (started = true));

  const firstBound = first.continueInterruptedRun();
  await new Promise((resolve) => setImmediate(resolve));
  expect(started).toBe(false);
  env.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  await Promise.all([firstBound, second.continueInterruptedRun(), waiting]);
  expect(started).toBe(true);
  await Promise.all([other, first, second].map((store) => store.close()));
});

test("a prompt waits for the office's interrupted runs before it starts the model", async () => {
  const env = setup();
  const store = await SessionStore.open(env.office, "C123:3.000003");
  let release!: () => void;
  const continued = new Promise<void>((resolve) => (release = resolve));
  const waited = vi.spyOn(store, "whenContinued").mockReturnValue(continued);
  env.faux.setResponses([fauxAssistantMessage("answer")]);
  const callsBefore = env.faux.state.callCount;

  const run = env.wrap(store).prompt("a new message");
  await vi.waitFor(() => expect(waited).toHaveBeenCalled());
  expect(env.faux.state.callCount).toBe(callsBefore);
  release();
  await run;
  await store.close();

  expect(env.faux.state.callCount).toBe(callsBefore + 1);
});

test("a child conversation that an interrupted run owns continues with it", async () => {
  const env = setup();
  const store = await SessionStore.open(env.office, "C123:1.000001");
  env.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
  ]);
  const running = env.toolStarted();
  const run = env
    .wrap(store)
    .prompt("delegate the work")
    .catch(() => undefined);
  await running;
  await store.close();
  await run;

  expect(await SessionStore.continueInterrupted(env.office)).toEqual(["C123:1.000001"]);
  const reopened = await SessionStore.open(env.office, "C123:1.000001");
  let parentSaw = "";
  env.faux.setResponses([
    fauxAssistantMessage("child finished"),
    (context) => {
      parentSaw = JSON.stringify(context.messages);
      return fauxAssistantMessage("parent finished");
    },
  ]);
  await env.wrap(reopened).continueInterrupted();
  await reopened.close();

  expect(parentSaw).toContain("child said child finished");
});

test("an office that was not planned for continuation aborts its interrupted work when opened", async () => {
  const env = setup();
  await interrupt(env, ["C123:1.000001"]);

  const store = await SessionStore.open(env.office, "C123:1.000001");
  await store.close();

  expect(await SessionStore.continueInterrupted(env.office)).toEqual([]);
});

test("an office idle longer than the continuation window is not continued", async () => {
  const env = setup();
  await interrupt(env, ["C123:1.000001"]);
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(env.office.sessionsPath, old, old);

  expect(await SessionStore.continueInterrupted(env.office)).toEqual([]);
});
