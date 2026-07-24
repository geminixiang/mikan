import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";

/** Conversation-bound Slack Block Kit operations, provided by the host. */
export interface SlackBlockKitOps {
  postBlocks(args: { text: string; blocks: object[]; threadTs?: string }): Promise<{ ts: string }>;
  updateBlocks(args: { ts: string; text: string; blocks: object[] }): Promise<void>;
}

const blockkitSchema = Type.Object({
  blocks: Type.Array(Type.Unknown(), {
    description:
      "Slack Block Kit blocks (max 50). Use {type:'markdown', text} for prose, {type:'table'} for tables, and actions/section blocks for buttons and select menus.",
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
      "Post an interactive Slack Block Kit message (buttons, select menus, custom layouts) to the current conversation, or update one previously posted with this tool. Normal replies already render Markdown — use this only when you need interactive elements or a layout Markdown cannot express. When a user clicks a button or picks an option, you receive a new message '[Slack action] <action_id>: <value>' — choose descriptive action_ids and values so the interaction tells you what to do. Returns the message ts; pass it back as update_ts to edit the message later (e.g. refreshing vote tallies). If Slack rejects the blocks, the error includes its validation messages — fix the JSON and retry.",
    parameters: blockkitSchema,
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
