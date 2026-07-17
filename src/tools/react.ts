import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { defineHostFnTool } from "./host-fn-tool.js";

const reactSchema = Type.Object({
  emoji: Type.String({
    description:
      "Emoji to react with. Use a short name without colons (e.g. eyes, white_check_mark, +1) on Slack, or a Unicode emoji on Discord/Telegram.",
  }),
});

/**
 * The `react` tool adds an emoji reaction to the message that triggered the
 * current run. The channel and message timestamp are captured per run via
 * {@link createReactTool}'s setter; the model only supplies the emoji.
 */
export function createReactTool(): {
  tool: AgentTool<typeof reactSchema>;
  setReactFunction: (fn: ((emoji: string) => Promise<void>) | null) => void;
} {
  const { tool, setFn } = defineHostFnTool<(emoji: string) => Promise<void>, typeof reactSchema>({
    name: "react",
    description:
      "Add an emoji reaction to the message you are responding to. Useful for a lightweight acknowledgement (e.g. eyes to show you saw a request, white_check_mark when done) instead of a full reply.",
    parameters: reactSchema,
    unavailable: "Reactions are not supported in this conversation.",
    run: async (reactFn, { emoji }) => {
      await reactFn(emoji);
      return {
        content: [{ type: "text" as const, text: `Reacted with :${emoji.replace(/^:|:$/g, "")}:` }],
        details: undefined,
      };
    },
  });

  return { tool, setReactFunction: setFn };
}
