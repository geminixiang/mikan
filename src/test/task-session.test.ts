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

test("a task interrupted by a restart continues its own turn and reports to its requester", async () => {
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

  expect(await SessionStore.continueInterrupted(office)).toEqual(["D123:1.000001"]);
  const continued = await SessionStore.openTask(office, "D123:1.000001", "D123", {
    acknowledgement: "On it.",
  });
  let continuedWith = "";
  faux.setResponses([
    (context) => {
      continuedWith = JSON.stringify(context.messages);
      return fauxAssistantMessage("task finished");
    },
  ]);
  await wrap(continued).continueInterrupted();
  await continued.close();

  expect(continuedWith).toContain("Tool slow was interrupted");
  expect((await SessionStore.inspectExecution(office, "D123:1.000001")).result?.status).toBe(
    "completed",
  );
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
