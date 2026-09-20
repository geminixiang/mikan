import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { MikanAgentSession, MikanModels } from "../harness/index.js";
import { createTaskTool } from "../harness/tools/task.js";
import { SessionStore } from "../sessions/session-store.js";
let dir: string;
let store: SessionStore;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "task-handoff-"));
  store = await SessionStore.create(join(dir, "session.jsonl"), dir);
});
afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  const { tool, setTaskFunction } = createTaskTool();
  const start = vi.fn().mockResolvedValue("D1:123");
  setTaskFunction(start);
  const effect = vi
    .fn()
    .mockResolvedValue({ content: [{ type: "text", text: "effect" }], details: {} });
  const session = new MikanAgentSession({
    models,
    model: faux.getModel(),
    sessionStore: store,
    tools: [
      tool,
      {
        name: "effect",
        label: "effect",
        description: "effect",
        parameters: { type: "object", properties: {} },
        execute: effect,
      },
    ],
    systemPrompt: "test",
    thinkingLevel: "off",
  });
  return { session, faux, start, effect };
}
test("handoff terminates without a followup model call", async () => {
  const { session, faux, start } = setup();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("start_task", { message: "On it", task: "investigate" })),
  ]);
  await session.prompt("work", { allowTaskHandoff: true });
  expect(start).toHaveBeenCalledWith("On it", "investigate");
  expect(faux.state.callCount).toBe(1);
});
test("mixed handoff batch blocks every effect before allowing a corrected single call", async () => {
  const { session, faux, start, effect } = setup();
  const handoff = fauxToolCall("start_task", { message: "On it", task: "investigate" });
  faux.setResponses([
    fauxAssistantMessage([handoff, fauxToolCall("effect", {})]),
    fauxAssistantMessage(fauxToolCall("start_task", { message: "On it", task: "investigate" })),
  ]);
  await session.prompt("work", { allowTaskHandoff: true });
  expect(start).toHaveBeenCalledTimes(1);
  expect(effect).not.toHaveBeenCalled();
});
test("handoff is not advertised on unsupported turns", async () => {
  const { session, faux } = setup();
  faux.setResponses([
    (context) => {
      expect(getCurrentTools(context.messages).map((tool) => tool.name)).not.toContain(
        "start_task",
      );
      return fauxAssistantMessage("answer");
    },
  ]);
  await session.prompt("work");
});
