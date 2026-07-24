import { describe, expect, test, vi } from "vitest";
import { createSlackToolPack, type PlatformSlackOps } from "../src/adapters/slack/tool-pack.js";
import {
  createSlackBlockKitTool,
  type SlackBlockKitOps,
} from "../src/adapters/slack/tools/blockkit.js";

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
    const ops: PlatformSlackOps = { postBlocks, updateBlocks: vi.fn(async () => {}) };
    const pack = createSlackToolPack(ops);
    const tool = pack.tools[0];

    pack.bindRun({ conversationId: "C123", platformName: "slack" });
    await tool.execute(...executeArgs({ blocks: BLOCKS, text: "t" }));
    expect(postBlocks).toHaveBeenCalledWith("C123", {
      text: "t",
      blocks: BLOCKS,
      threadTs: undefined,
    });

    pack.bindRun({ conversationId: "D999", platformName: "discord" });
    await expect(tool.execute(...executeArgs({ blocks: BLOCKS, text: "t" }))).rejects.toThrow(
      "only available in Slack conversations",
    );
  });
});
