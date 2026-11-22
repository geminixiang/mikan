import {
  AgentDoc,
  AssistantEntry,
  configure,
  UsageDoc,
  type ConversationId,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "typebox";
import type { MikanToolContext } from "../types.js";
import { MAX_OWNED_CONVERSATIONS } from "../../sessions/session-store.js";
import { sumUsageState } from "../session.js";
import { withLabelParameter } from "./host-fn-tool.js";

const SUBAGENT_TOOL = "subagent";

const CHILD_TOOLS = ["read", "bash", "edit", "write"];
const OWNER_ONLY_EXTENSIONS = new Set(["codemode", "tool_search"]);
const MAX_CHILD_TURNS = 100;

const parameters = Type.Object({
  task: Type.String({
    minLength: 1,
    description:
      "Everything the subagent needs: the goal, the paths, the constraints, and what to return. It sees nothing of this conversation.",
  }),
});

function childInstructions(parentPrompt: string): string {
  return `${parentPrompt}

## Subagent
You are a subagent: the agent of this conversation handed you one task. You have only ${CHILD_TOOLS.join(", ")}; ignore instructions above about other tools. You cannot post to the chat or delegate. Your final message is returned to that agent as the tool result, so make it the complete answer: the result, the files you changed, and what you verified.`;
}

async function childConversation(
  api: ToolExecutionApi,
  instructions: string,
  context: Context,
): Promise<ConversationId> {
  return api.commit(async (tx) => {
    const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
    if (existing !== undefined) return existing.id;
    const created = await tx.createConversation({
      ownership: { kind: "task", taskId: api.taskId },
    });
    const registered = new Map(api.registry.tools().map(({ tool }) => [tool.name, tool]));
    const tools = CHILD_TOOLS.flatMap((name) => registered.get(name) ?? []);
    const selected = (await tx.doc(AgentDoc, api.conversationId)).extensions;
    const extensions = (Array.isArray(selected) ? selected : [])
      .filter((name) => !OWNER_ONLY_EXTENSIONS.has(name))
      .flatMap((name) => api.registry.extension(name) ?? []);
    await configure(tx, created.id, {
      extensions,
      tools,
      modelTools: tools,
      instructions,
      maxTurns: MAX_CHILD_TURNS,
    });
    return created.id;
  }, context);
}

export function createSubagentTool(toolContext: MikanToolContext): ToolRegistration {
  return {
    name: SUBAGENT_TOOL,
    callers: ["model"],
    replay: "safe",
    description: `Hand one self-contained task to a subagent and get its final answer back. The subagent starts without this conversation, works in the same sandbox with ${CHILD_TOOLS.join(", ")}, and cannot delegate. It costs more than doing the work yourself: it starts cold, rereads what you already know, and shares this sandbox's CPU and memory, so parallel subagents do not finish heavy work sooner. Use it only to keep a large, separable investigation out of your context. At most ${MAX_OWNED_CONVERSATIONS} run at once; more wait their turn.`,
    parameters: withLabelParameter(parameters, "required"),
    execute: async (args, api, context) => {
      const host = toolContext.subagents;
      if (!host) throw new Error("Subagents are unavailable here; do the work yourself.");
      const { task } = args as { task: string };
      const child = await childConversation(api, childInstructions(host.instructions()), context);
      await api.details({ conversationId: child }, context);
      const release = await host.acquireSlot(context.abortSignal);
      try {
        const handle = await api.conversation(child, context);
        if (!handle) throw new Error(`Subagent conversation ${child} is missing`);
        const submission = await handle.submit(
          { type: "input", content: task, requestId: `${SUBAGENT_TOOL}:${api.taskId}` },
          context,
        );
        const settled = await submission.wait(context);
        const state = await api.snapshot(UsageDoc, child, context);
        const usage = state ? sumUsageState(state) : undefined;
        if (settled.status !== "done" || settled.type !== "input") {
          const reason = settled.status === "done" ? "gave no answer" : settled.reason;
          return {
            output: [{ type: "text", text: `The subagent did not finish (${reason}).` }],
            usage,
          };
        }
        const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
        const message = entry?.model?.[0];
        const text =
          message?.role === "assistant"
            ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
            : "";
        return {
          output: [{ type: "text", text: text || "The subagent returned no text." }],
          usage,
        };
      } finally {
        release();
      }
    },
  };
}
