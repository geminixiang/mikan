import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { defineHostFnTool } from "./host-fn-tool.js";

export const REACT_TOOL = "react";

const reactSchema = Type.Object({
  emoji: Type.String({
    description:
      "Emoji to react with. Use a short name without colons (e.g. eyes, white_check_mark, +1) on Slack, or a Unicode emoji on Discord/Telegram.",
  }),
});

export function createReactTool(): {
  tool: AgentTool<typeof reactSchema>;
  setReactFunction: (fn: ((emoji: string) => Promise<void>) | null) => void;
} {
  const { tool, setFn } = defineHostFnTool<(emoji: string) => Promise<void>, typeof reactSchema>({
    name: REACT_TOOL,
    description:
      "Add an emoji reaction to the message you are responding to. mikan already reacts on its own when work starts; use this for a lightweight signal such as eyes on a background check with nothing to report.",
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
