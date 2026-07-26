import { describe, expect, test, vi } from "vitest";
import { createSlackToolPack } from "../src/adapters/slack/tool-pack.js";
import { createSlackBlockKitTool } from "../src/adapters/slack/tools/blockkit.js";
import type { PlatformSlackOps, SlackBlockKitOps } from "../src/adapters/slack/types.js";

const BLOCKS = [
  { type: "markdown", text: "Vote:" },
  { type: "actions", elements: [] },
];

function executeArgs(input: Record<string, unknown>) {
  return ["call-1", input, undefined, undefined, undefined as never] as const;
}

describe("slack_blockkit tool", () => {
  test("posts blocks and returns the message ts", async () => {
    const { tool, setSlackBlockKitOps } = createSlackBlockKitTool();
    const ops: SlackBlockKitOps = {
      postBlocks: vi.fn(async () => ({ ts: "123.456" })),
      updateBlocks: vi.fn(async () => {}),
    };
    setSlackBlockKitOps(ops);

    const result = await tool.execute(...executeArgs({ blocks: BLOCKS, text: "Vote:" }));

    expect(ops.postBlocks).toHaveBeenCalledWith({
      text: "Vote:",
      blocks: BLOCKS,
      threadTs: undefined,
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("123.456");
  });

  test("rejects an oversized payload without quoting it back", async () => {
    // Schema validation reports a failure by embedding the whole argument
    // object, so an unbounded payload lands in the session twice: once as the
    // call, once echoed as the result. The complaint has to stay small.
    const { tool } = createSlackBlockKitTool();
    const huge = { blocks: [{ type: "markdown", text: "x".repeat(100_000) }], text: "report" };

    expect(() => tool.prepareArguments?.(huge)).toThrow(/over the 64KB limit/);
    try {
      tool.prepareArguments?.(huge);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message.length).toBeLessThan(300);
      expect(message).not.toContain("xxxx");
    }
  });

  test("rejects more blocks than Slack accepts", () => {
    const { tool } = createSlackBlockKitTool();
    const blocks = Array.from({ length: 51 }, () => ({ type: "divider" }));

    expect(() => tool.prepareArguments?.({ blocks, text: "t" })).toThrow(
      "accepts at most 50 blocks, got 51",
    );
  });

  test("passes a normal payload through untouched", () => {
    const { tool } = createSlackBlockKitTool();
    const args = { blocks: BLOCKS, text: "Vote:" };

    expect(tool.prepareArguments?.(args)).toBe(args);
  });

  test("routes thread_ts to a thread post", async () => {
    const { tool, setSlackBlockKitOps } = createSlackBlockKitTool();
    const ops: SlackBlockKitOps = {
      postBlocks: vi.fn(async () => ({ ts: "2.0" })),
      updateBlocks: vi.fn(async () => {}),
    };
    setSlackBlockKitOps(ops);

    await tool.execute(...executeArgs({ blocks: BLOCKS, text: "t", thread_ts: "1.0" }));

    expect(ops.postBlocks).toHaveBeenCalledWith({ text: "t", blocks: BLOCKS, threadTs: "1.0" });
  });

  test("routes update_ts to an update instead of a post", async () => {
    const { tool, setSlackBlockKitOps } = createSlackBlockKitTool();
    const ops: SlackBlockKitOps = {
      postBlocks: vi.fn(async () => ({ ts: "9.9" })),
      updateBlocks: vi.fn(async () => {}),
    };
    setSlackBlockKitOps(ops);

    await tool.execute(...executeArgs({ blocks: BLOCKS, text: "t", update_ts: "5.5" }));

    expect(ops.updateBlocks).toHaveBeenCalledWith({ ts: "5.5", text: "t", blocks: BLOCKS });
    expect(ops.postBlocks).not.toHaveBeenCalled();
  });

  test("fails with a helpful error when not bound to Slack", async () => {
    const { tool } = createSlackBlockKitTool();
    await expect(tool.execute(...executeArgs({ blocks: BLOCKS, text: "t" }))).rejects.toThrow(
      "only available in Slack conversations",
    );
  });

  test("surfaces Slack validation detail on invalid_blocks", async () => {
    const { tool, setSlackBlockKitOps } = createSlackBlockKitTool();
    const slackError = Object.assign(new Error("An API error occurred: invalid_blocks"), {
      data: {
        error: "invalid_blocks",
        response_metadata: {
          messages: ["[ERROR] failed to match all allowed schemas [json-pointer:/blocks/1]"],
        },
      },
    });
    setSlackBlockKitOps({
      postBlocks: vi.fn(async () => {
        throw slackError;
      }),
      updateBlocks: vi.fn(async () => {}),
    });

    await expect(tool.execute(...executeArgs({ blocks: BLOCKS, text: "t" }))).rejects.toThrow(
      /invalid_blocks[\s\S]*json-pointer\/?:\/blocks\/1/,
    );
  });
});

describe("slack tool pack", () => {
  test("binds conversation-scoped ops for slack runs and disables elsewhere", async () => {
    const postBlocks = vi.fn(async () => ({ ts: "1.1" }));
    const ops: PlatformSlackOps = {
      postBlocks,
      updateBlocks: vi.fn(async () => {}),
      ownsBlockKitMessage: vi.fn(() => false),
    };
    const pack = createSlackToolPack(ops);
    const tool = pack.tools[0];

    pack.bindRun({ conversationId: "C123", platformName: "slack", threadTs: "10.0" });
    await tool.execute(...executeArgs({ blocks: BLOCKS, text: "t" }));
    expect(postBlocks).toHaveBeenCalledWith("C123", {
      text: "t",
      blocks: BLOCKS,
      threadTs: "10.0",
    });

    pack.bindRun({ conversationId: "D999", platformName: "discord" });
    await expect(tool.execute(...executeArgs({ blocks: BLOCKS, text: "t" }))).rejects.toThrow(
      "only available in Slack conversations",
    );
  });

  test("rejects posts outside the active thread", async () => {
    const ops: PlatformSlackOps = {
      postBlocks: vi.fn(async () => ({ ts: "1.1" })),
      updateBlocks: vi.fn(async () => {}),
      ownsBlockKitMessage: vi.fn(() => false),
    };
    const pack = createSlackToolPack(ops);
    const tool = pack.tools[0];
    pack.bindRun({ conversationId: "C123", platformName: "slack", threadTs: "10.0" });

    await expect(
      tool.execute(...executeArgs({ blocks: BLOCKS, text: "t", thread_ts: "different-thread" })),
    ).rejects.toThrow("cannot post outside the active conversation thread");
    expect(ops.postBlocks).not.toHaveBeenCalled();
  });

  test("only updates messages posted by the tool in the bound conversation", async () => {
    const updateBlocks = vi.fn(async () => {});
    const ops: PlatformSlackOps = {
      postBlocks: vi.fn(async () => ({ ts: "owned-message" })),
      updateBlocks,
      ownsBlockKitMessage: vi.fn(() => false),
    };
    const pack = createSlackToolPack(ops);
    const tool = pack.tools[0];
    pack.bindRun({ conversationId: "C123", platformName: "slack" });

    await expect(
      tool.execute(...executeArgs({ blocks: BLOCKS, text: "t", update_ts: "foreign-message" })),
    ).rejects.toThrow("can only update messages posted by this tool");

    await tool.execute(...executeArgs({ blocks: BLOCKS, text: "t" }));
    await tool.execute(
      ...executeArgs({ blocks: BLOCKS, text: "updated", update_ts: "owned-message" }),
    );
    expect(updateBlocks).toHaveBeenCalledWith("C123", {
      ts: "owned-message",
      text: "updated",
      blocks: BLOCKS,
    });

    pack.bindRun({ conversationId: "C123", platformName: "slack", threadTs: "new-thread" });
    await expect(
      tool.execute(...executeArgs({ blocks: BLOCKS, text: "t", update_ts: "owned-message" })),
    ).rejects.toThrow("can only update messages posted by this tool");

    const restoredUpdateBlocks = vi.fn(async () => {});
    const restoredPack = createSlackToolPack({
      postBlocks: vi.fn(async () => ({ ts: "new-message" })),
      updateBlocks: restoredUpdateBlocks,
      ownsBlockKitMessage: vi.fn(
        (_conversationId, ts, threadTs) => ts === "owned-message" && threadTs === "original-thread",
      ),
    });
    restoredPack.bindRun({
      conversationId: "C123",
      platformName: "slack",
      threadTs: "original-thread",
    });
    await restoredPack.tools[0].execute(
      ...executeArgs({ blocks: BLOCKS, text: "restored", update_ts: "owned-message" }),
    );
    expect(restoredUpdateBlocks).toHaveBeenCalledWith("C123", {
      ts: "owned-message",
      text: "restored",
      blocks: BLOCKS,
      threadTs: "original-thread",
    });
  });
});
