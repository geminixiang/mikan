import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ConversationResponder } from "../../adapter.js";

/** A handoff, not a nested run: completion means admitted, not finished. */
export function createTaskTool() {
  let start: ConversationResponder["startTask"];
  const parameters = Type.Object({
    message: Type.String({
      minLength: 1,
      description:
        "Brief, conversational acknowledgement in the user's language. Sound like a helpful colleague, not a project plan: e.g. 好，我來整理一下，弄好再通知你。 Do not repeat the full request or promise an exact completion time.",
    }),
    task: Type.String({
      minLength: 1,
      description:
        "Self-contained task, including context, constraints and attachment paths. The task does not inherit your private tool history.",
    }),
  });
  const tool: AgentTool<typeof parameters> = {
    name: "start_task",
    label: "start_task",
    parameters,
    description:
      "Hand off multi-step or time-consuming work to an independent task thread so the user can keep chatting. Call ALONE, before doing that work. Ends this turn on success. Only available in top-level Slack DMs.",
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted();
      if (!start)
        throw new Error("Task handoff is unavailable here; continue in this conversation.");
      const target = await start(args.message, args.task);
      return {
        content: [{ type: "text", text: `Task admitted: ${target}` }],
        details: { target },
        terminate: true,
      };
    },
  };
  return {
    tool,
    setTaskFunction: (fn: ConversationResponder["startTask"]) => {
      start = fn;
    },
  };
}
