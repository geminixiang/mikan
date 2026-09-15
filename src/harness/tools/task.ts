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

function createTaskStatusTool() {
  let query: ConversationResponder["getTaskStatus"];
  const parameters = Type.Object({
    sessionKey: Type.Optional(
      Type.String({
        description: "Task session reference from start_task. Omit to list recent tasks.",
      }),
    ),
  });
  const tool: AgentTool<typeof parameters> = {
    name: "task_status",
    label: "task_status",
    parameters,
    description:
      "Read actual background task execution status. ALWAYS use this before answering task progress questions; do not infer progress or ETA from elapsed time or your previous promises. Completed means execution ended, not verified domain success. Read-only; does not steer or restart work.",
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted();
      if (!query) throw new Error("Task status is unavailable in this conversation.");
      return {
        content: [{ type: "text", text: JSON.stringify(await query(args.sessionKey)) }],
        details: undefined,
      };
    },
  };
  return {
    tool,
    setTaskStatusFunction: (fn: ConversationResponder["getTaskStatus"]) => {
      query = fn;
    },
  };
}

export function createTaskTools() {
  const handoff = createTaskTool();
  const status = createTaskStatusTool();
  return {
    tools: [handoff.tool, status.tool],
    bindTasks(responder: ConversationResponder) {
      handoff.setTaskFunction(responder.startTask?.bind(responder));
      status.setTaskStatusFunction(responder.getTaskStatus?.bind(responder));
    },
  };
}
