import type { PlatformToolPack } from "../../tools/types.js";
import { createSlackBlockKitTool } from "./tools/blockkit.js";

/**
 * Host-side Slack operations for the Slack tool pack, keyed by conversation.
 * main.ts implements these against the running SlackMessagingBot.
 */
export interface PlatformSlackOps {
  postBlocks(
    conversationId: string,
    args: { text: string; blocks: object[]; threadTs?: string },
  ): Promise<{ ts: string }>;
  updateBlocks(
    conversationId: string,
    args: { ts: string; text: string; blocks: object[] },
  ): Promise<void>;
}

/**
 * Slack capability pack: tools that post platform-native surfaces (Block Kit)
 * the response renderer deliberately does not produce. bindRun enables the
 * tools only for slack-named conversations so multi-platform processes stay
 * safe.
 */
export function createSlackToolPack(ops: PlatformSlackOps): PlatformToolPack {
  const { tool: blockkitTool, setSlackBlockKitOps } = createSlackBlockKitTool();

  return {
    tools: [blockkitTool],
    bindRun({ conversationId, platformName }) {
      if (platformName !== "slack") {
        setSlackBlockKitOps(null);
        return;
      }
      setSlackBlockKitOps({
        postBlocks: (args) => ops.postBlocks(conversationId, args),
        updateBlocks: (args) => ops.updateBlocks(conversationId, args),
      });
    },
  };
}
