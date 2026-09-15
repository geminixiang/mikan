import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ConversationResponder } from "../../adapter.js";

export function createTaskStatusTool() {
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
