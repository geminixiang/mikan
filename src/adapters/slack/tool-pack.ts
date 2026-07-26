import type { PlatformToolPack } from "../../tools/types.js";
import { createSlackBlockKitTool } from "./tools/blockkit.js";
export type { PlatformSlackOps } from "./types.js";
import type { PlatformSlackOps } from "./types.js";

/**
 * Slack capability pack: tools that post platform-native surfaces (Block Kit)
 * the response renderer deliberately does not produce. bindRun enables the
 * tools only for slack-named conversations so multi-platform processes stay
 * safe.
 */
export function createSlackToolPack(ops: PlatformSlackOps): PlatformToolPack {
  const { tool: blockkitTool, setSlackBlockKitOps } = createSlackBlockKitTool();
  const ownedMessageTs = new Set<string>();
  let boundTarget: string | undefined;

  return {
    tools: [blockkitTool],
    bindRun({ conversationId, platformName, threadTs }) {
      if (platformName !== "slack") {
        setSlackBlockKitOps(null);
        return;
      }
      const target = `${conversationId}:${threadTs ?? "top-level"}`;
      if (boundTarget !== target) {
        ownedMessageTs.clear();
        boundTarget = target;
      }
      setSlackBlockKitOps({
        postBlocks: async (args) => {
          if (args.threadTs !== undefined && args.threadTs !== threadTs) {
            throw new Error("slack_blockkit cannot post outside the active conversation thread");
          }
          const result = await ops.postBlocks(conversationId, { ...args, threadTs });
          ownedMessageTs.add(result.ts);
          return result;
        },
        updateBlocks: async (args) => {
          if (
            !ownedMessageTs.has(args.ts) &&
            !ops.ownsBlockKitMessage(conversationId, args.ts, threadTs)
          ) {
            throw new Error("slack_blockkit can only update messages posted by this tool");
          }
          await ops.updateBlocks(conversationId, { ...args, threadTs });
          ownedMessageTs.add(args.ts);
        },
      });
    },
  };
}
