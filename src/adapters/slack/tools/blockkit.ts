import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

/** Conversation-bound Slack Block Kit operations, provided by the host. */
export interface SlackBlockKitOps {
  postBlocks(args: { text: string; blocks: object[]; threadTs?: string }): Promise<{ ts: string }>;
  updateBlocks(args: { ts: string; text: string; blocks: object[] }): Promise<void>;
}

/** Slack's own ceilings: 50 blocks per message, and a payload well under 64KB. */
const MAX_BLOCKS = 50;
const MAX_ARGUMENT_BYTES = 64 * 1024;

const blockkitSchema = Type.Object({
  blocks: Type.Array(Type.Unknown(), {
    maxItems: MAX_BLOCKS,
    description: `Slack Block Kit blocks (max ${MAX_BLOCKS}). Use {type:'markdown', text} for prose, {type:'table'} for tables, and actions/section blocks for buttons and select menus.`,
  }),
  text: Type.String({
    description: "Plain-text fallback shown in notifications and screen readers",
  }),
  thread_ts: Type.Optional(
    Type.String({
      description:
        "Post into this thread (the TS from the [in-thread:TS] message marker). Omit for a top-level channel message.",
    }),
  ),
  update_ts: Type.Optional(
    Type.String({
      description:
        "Update the existing message with this ts (returned by a previous slack_blockkit call) instead of posting a new one.",
    }),
  ),
});

/**
 * Reject a runaway payload before schema validation sees it.
 *
 * `prepareArguments` runs ahead of validation, which reports a failure by
 * embedding the entire argument object in its message. A malformed multi-
 * hundred-KB `blocks` array therefore lands in the session twice — once as the
 * call, once echoed back as the result — and every later reader pays for it.
 * Only a bounded result belongs there, so the size complaint stays short and
 * never quotes what it rejected.
 */
function guardBlockKitArguments(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const bytes = Buffer.byteLength(JSON.stringify(args) ?? "", "utf-8");
  if (bytes > MAX_ARGUMENT_BYTES) {
    throw new Error(
      `slack_blockkit arguments are ${Math.round(bytes / 1024)}KB, over the ${MAX_ARGUMENT_BYTES / 1024}KB limit. ` +
        "Post a short message and attach the long content as a file instead.",
    );
  }
  const blocks = (args as { blocks?: unknown }).blocks;
  if (Array.isArray(blocks) && blocks.length > MAX_BLOCKS) {
    throw new Error(`slack_blockkit accepts at most ${MAX_BLOCKS} blocks, got ${blocks.length}.`);
  }
  return args;
}

function formatSlackApiError(err: unknown): Error {
  const data = (
    err as { data?: { error?: string; response_metadata?: { messages?: string[] } } } | undefined
  )?.data;
  if (!data?.error) return err instanceof Error ? err : new Error(String(err));
  const details = data.response_metadata?.messages?.length
    ? `\n${data.response_metadata.messages.join("\n")}`
    : "";
  return new Error(
    `Slack rejected the request: ${data.error}${details}\nFix the blocks JSON and retry.`,
  );
}

export function createSlackBlockKitTool(): {
  tool: AgentTool<typeof blockkitSchema>;
  setSlackBlockKitOps: (ops: SlackBlockKitOps | null) => void;
} {
  let boundOps: SlackBlockKitOps | null = null;

  const tool: AgentTool<typeof blockkitSchema> = {
    name: "slack_blockkit",
    label: "slack_blockkit",
    description:
      "Post an interactive Slack Block Kit message (buttons, select menus, custom layouts) to the current conversation, or update one previously posted with this tool. Normal replies already render Markdown — use this only when you need interactive elements or a layout Markdown cannot express. When a user clicks a button or picks an option, you receive a new message '[Slack action] <action_id>: <value>' — choose descriptive action_ids and values so the interaction tells you what to do. Returns the message ts; pass it back as update_ts to edit the message later (e.g. refreshing vote tallies). After handling an interaction, update the message via update_ts to replace the buttons with the outcome (e.g. '✅ approved') — buttons stay clickable otherwise and repeated clicks re-trigger the action. If Slack rejects the blocks, the error includes its validation messages — fix the JSON and retry.",
    parameters: blockkitSchema,
    prepareArguments: guardBlockKitArguments as (args: unknown) => typeof blockkitSchema.static,
    execute: async (
      _toolCallId: string,
      {
        blocks,
        text,
        thread_ts,
        update_ts,
      }: { blocks: unknown[]; text: string; thread_ts?: string; update_ts?: string },
      signal?: AbortSignal,
    ) => {
      const ops = boundOps;
      if (!ops) {
        throw new Error("slack_blockkit is only available in Slack conversations");
      }
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      try {
        if (update_ts) {
          await ops.updateBlocks({ ts: update_ts, text, blocks: blocks as object[] });
          return {
            content: [
              { type: "text" as const, text: `Updated Block Kit message (ts: ${update_ts}).` },
            ],
            details: undefined,
          };
        }
        const { ts } = await ops.postBlocks({
          text,
          blocks: blocks as object[],
          threadTs: thread_ts,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Posted Block Kit message (ts: ${ts}). Interactive elements will arrive as "[Slack action] <action_id>: <value>" messages; pass ts back as update_ts to edit this message.`,
            },
          ],
          details: undefined,
        };
      } catch (err) {
        throw formatSlackApiError(err);
      }
    },
  };

  return {
    tool,
    setSlackBlockKitOps: (ops) => {
      boundOps = ops;
    },
  };
}
