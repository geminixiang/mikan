import type { Context } from "@earendil-works/chord";
import { contentText, type Api, type Model } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  UsageDoc,
  configure,
  defineTool,
  type ConversationId,
  type Extension,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { OWNER_ONLY_EXTENSIONS, sumUsageState } from "../session.js";
import { LABEL_PARAMETER } from "./host-fn-tool.js";

export const SUBAGENT_TOOL = "subagent";

const parameters = Type.Object({
  label: LABEL_PARAMETER,
  task: Type.String({
    minLength: 1,
    description: "Everything the subagent needs: it starts without this conversation's context.",
  }),
});

function instructions(toolNames: string[]): string {
  return [
    "You are a subagent working for another agent. Do only the task you are given.",
    `Your tools: ${toolNames.join(", ") || "none"}. Use them for any claim about files, commands, or external state; never invent tool output.`,
    "Your caller sees only your final message, so make it the complete result.",
  ].join("\n");
}

function grantedTools(api: ToolExecutionApi, delegable: ReadonlySet<string>): ToolRegistration[] {
  const granted = new Map<string, ToolRegistration>();
  for (const { tool } of api.registry.tools()) {
    if (delegable.has(tool.name) && !granted.has(tool.name)) granted.set(tool.name, tool);
  }
  return [...granted.values()];
}

async function ownerExtensions(api: ToolExecutionApi, context: Context): Promise<Extension[]> {
  const owner = (await api.snapshot(AgentDoc, api.conversationId, context))?.extensions;
  return (Array.isArray(owner) ? owner : []).flatMap((name) => {
    const extension = OWNER_ONLY_EXTENSIONS.includes(name)
      ? undefined
      : api.registry.extension(name);
    return extension ? [extension] : [];
  });
}

async function childConversation(
  api: ToolExecutionApi,
  context: Context,
  model: Model<Api>,
  delegable: ReadonlySet<string>,
): Promise<ConversationId> {
  const name = `subagent:${api.callId}`;
  const known = await api.memo<ConversationId>(name, context);
  if (known !== undefined) return known;
  const tools = grantedTools(api, delegable);
  const extensions = await ownerExtensions(api, context);
  const created = await api.commit(async (tx) => {
    const conversation = await tx.createConversation({
      ownership: { kind: "task", taskId: api.taskId },
    });
    await configure(tx, conversation.id, {
      extensions,
      model: { provider: model.provider, modelId: model.id },
      tools,
      modelTools: tools,
      instructions: instructions(tools.map((tool) => tool.name)),
    });
    return conversation.id;
  }, context);
  return api.memo<ConversationId>(name, created, context);
}

export function createSubagentTool(
  model: Model<Api>,
  delegable: ReadonlySet<string>,
): ToolRegistration {
  return defineTool({
    name: SUBAGENT_TOOL,
    replay: "safe",
    description:
      "Hand a self-contained task to a subagent: a fresh conversation with the same model, sandbox, and tools (except this one and the task tools). " +
      "Only its final answer comes back here, so what it reads stays out of this conversation. " +
      "Calls in one turn run at the same time and share one sandbox.",
    parameters,
    execute: async (args, api, context) => {
      const child = await childConversation(api, context, model, delegable);
      const handle = await api.conversation(child, context);
      if (!handle) throw new Error(`Subagent conversation ${child} is missing`);
      const stop = () => void handle.abort(context).catch(() => undefined);
      context.abortSignal?.addEventListener("abort", stop, { once: true });
      try {
        const submission = await handle.submit(
          { type: "input", content: args.task, requestId: `subagent:${api.callId}` },
          context,
        );
        const settled = await submission.wait(context);
        const usage = sumUsageState(
          (await api.snapshot(UsageDoc, child, context)) ?? { models: {}, tools: {} },
        );
        const answer =
          settled.status === "done" && settled.type === "input"
            ? await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
            : undefined;
        const message = answer?.model?.[0];
        const text = message?.role === "assistant" ? contentText(message.content, "") : "";
        if (!text) {
          const reason = settled.status === "done" ? "no answer" : (settled.reason ?? "unanswered");
          return {
            output: [{ type: "text", text: `Subagent did not finish: ${reason}` }],
            isError: true,
            usage,
          };
        }
        return { output: [{ type: "text", text }], usage };
      } finally {
        context.abortSignal?.removeEventListener("abort", stop);
      }
    },
  });
}
