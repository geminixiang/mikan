import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { SessionStore } from "../sessions/session-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-task-session-"));
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
  }).office(createOfficeAddress("slack", "D123"));
  let toolStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  const slow: AgentTool = {
    name: "slow",
    label: "slow",
    description: "Runs until aborted",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      toolStarted();
      await new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
      return { content: [{ type: "text", text: "never" }], details: undefined };
    },
  };
  const wrap = (store: SessionStore) =>
    new MikanAgentSession({
      model,
      models,
      sessionStore: store,
      tools: [slow],
      thinkingLevel: "off",
      systemPrompt: "prompt",
      settings: { compaction: { enabled: false } },
    });
  return { faux, office, started, wrap };
}

test("a task interrupted by a restart resumes with a new input after another conversation ran first", async () => {
  const { faux, office, started, wrap } = setup();
  const requester = await SessionStore.open(office, "D123");
  faux.setResponses([fauxAssistantMessage("hello")]);
  await wrap(requester).prompt("hi");
  const task = await SessionStore.openTask(office, "D123:1.000001", "D123", {
    acknowledgement: "On it.",
  });
  faux.setResponses([fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" })]);
  const interrupted = wrap(task)
    .prompt("long task")
    .catch(() => undefined);
  await started;
  await task.close();
  await requester.close();
  await interrupted;
  expect(await SessionStore.interruptedSince(office, ["D123:1.000001", "D123"], 0)).toEqual([
    "D123:1.000001",
  ]);

  const reopened = await SessionStore.open(office, "D123");
  faux.setResponses([fauxAssistantMessage("requester answer")]);
  await wrap(reopened).prompt("a message while the task is pending");
  const resumedTask = await SessionStore.openTask(office, "D123:1.000001", "D123", {
    acknowledgement: "On it.",
  });
  let resumedWith = "";
  faux.setResponses([
    (context) => {
      resumedWith = JSON.stringify(context.messages);
      return fauxAssistantMessage("task finished");
    },
  ]);
  await wrap(resumedTask).prompt("continue the task");
  await resumedTask.close();
  await reopened.close();

  expect(resumedWith).toContain("Tool slow was aborted");
  expect(resumedWith).toContain("continue the task");
  expect((await SessionStore.inspectExecution(office, "D123:1.000001")).result?.status).toBe(
    "completed",
  );
  expect(await SessionStore.interruptedSince(office, ["D123:1.000001"], 0)).toEqual([]);
});

test("a finished task's answer is written to its requester without a model turn", async () => {
  const { faux, office, wrap } = setup();
  const requester = await SessionStore.open(office, "D123");
  faux.setResponses([fauxAssistantMessage("hello")]);
  await wrap(requester).prompt("hi");
  await requester.close();
  await (
    await SessionStore.openTask(office, "D123:1.000001", "D123", { acknowledgement: "On it." })
  ).close();

  await SessionStore.reportTaskOutcome(office, "D123:1.000001", "the answer");

  const transcript = JSON.stringify(
    (await (await SessionStore.inspect(office, "D123"))!.buildSessionContext()).messages,
  );
  expect(transcript).toContain("[background task D123:1.000001 finished] the answer");
  expect(faux.state.callCount).toBe(1);
});

async function startedTask(office: Office, key: string): Promise<void> {
  await (await SessionStore.open(office, "D123")).close();
  const task = await SessionStore.openTask(office, key, "D123", { acknowledgement: "On it." });
  await task.recordRun({ startedAt: Date.now() });
  await task.close();
}

test("an interrupted task resumes twice, then its run is closed as aborted", async () => {
  const { office } = setup();
  const key = "D123:1.000001";
  await startedTask(office, key);

  expect(await SessionStore.claimResume(office, key, 2)).toBe("resume");
  expect(await SessionStore.claimResume(office, key, 2)).toBe("resume");
  expect(await SessionStore.claimResume(office, key, 2)).toBe("exhausted");

  expect(await SessionStore.interruptedSince(office, [key], 0)).toEqual([]);
  expect((await SessionStore.inspectExecution(office, key)).result?.status).toBe("aborted");
});

test("a run that ends resets the automatic resume count", async () => {
  const { office } = setup();
  const key = "D123:1.000001";
  await startedTask(office, key);
  expect(await SessionStore.claimResume(office, key, 2)).toBe("resume");
  expect(await SessionStore.claimResume(office, key, 2)).toBe("resume");

  const task = await SessionStore.openTask(office, key, "D123", { acknowledgement: "On it." });
  await task.recordRun({ startedAt: Date.now() });
  await task.recordRun({ endedAt: Date.now(), status: "completed" });
  await task.recordRun({ startedAt: Date.now() });
  await task.close();

  expect(await SessionStore.claimResume(office, key, 2)).toBe("resume");
});
