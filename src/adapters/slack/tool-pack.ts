import type { PlatformToolPack } from "../../harness/tools/types.js";
import { createSlackBlockKitTool, SLACK_BLOCKKIT_TOOL } from "./tools/blockkit.js";
import type { PlatformSlackOps } from "./types.js";

export function createSlackToolPack(ops: PlatformSlackOps): PlatformToolPack {
  const { tool: blockkitTool, setSlackBlockKitOps } = createSlackBlockKitTool();
  const ownedMessageTs = new Set<string>();
  let boundTarget: string | undefined;

  return {
    tools: [blockkitTool],
    finalResponseTools: [SLACK_BLOCKKIT_TOOL],
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
