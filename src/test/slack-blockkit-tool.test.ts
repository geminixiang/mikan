import { describe, expect, test, vi } from "vitest";
import { createSlackToolPack } from "../adapters/slack/tool-pack.js";
import { createSlackBlockKitTool } from "../adapters/slack/tools/blockkit.js";
import type { PlatformSlackOps, SlackBlockKitOps } from "../adapters/slack/types.js";
import type { PlatformToolPack } from "../harness/tools/types.js";
import { errorMessage } from "../unknown-values.js";
import { callableTool } from "./tool-api.js";

interface BlockKitInput {
  text: string;
  buttons?: Array<{ text: string; value: string; style?: "primary" | "danger" }>;
  menu?: {
    placeholder: string;
    options: Array<{ text: string; value: string }>;
    multiple?: boolean;
  };
  update_ts?: string;
}

const BUTTONS = [
  { text: "Approve", value: "yes", style: "primary" as const },
  { text: "Reject", value: "no" },
];

function executeArgs(input: BlockKitInput) {
  return ["call-1", { label: "Ask", ...input }, undefined, undefined] as const;
}

function onlyTool(pack: PlatformToolPack) {
  const [tool] = pack.tools;
  if (!tool) throw new Error("expected the slack tool pack to provide a tool");
  return tool;
}

function boundTool(overrides: Partial<SlackBlockKitOps> = {}) {
  const { tool, setSlackBlockKitOps } = createSlackBlockKitTool();
  const ops = {
    postBlocks: vi.fn<SlackBlockKitOps["postBlocks"]>(
      overrides.postBlocks ?? (async () => ({ ts: "123.456" })),
    ),
    updateBlocks: vi.fn<SlackBlockKitOps["updateBlocks"]>(async () => {}),
    resolveMentions: overrides.resolveMentions ?? ((text: string) => text),
  };
  setSlackBlockKitOps(ops);
  return { tool: callableTool(tool), ops, raw: tool };
}

function platformOps(overrides: Partial<PlatformSlackOps> = {}): PlatformSlackOps {
  return {
    postBlocks: vi.fn(async () => ({ ts: "1.1" })),
    updateBlocks: vi.fn(async () => {}),
    ownsBlockKitMessage: vi.fn(() => false),
    resolveMentions: (text) => text,
    ...overrides,
  };
}

describe("slack_blockkit tool", () => {
  test("posts the text rendered like any reply, with the buttons under it", async () => {
    const { tool, ops } = boundTool();

    const result = await tool.execute(
      ...executeArgs({
        text: "Deploy **v2**?\n\n| Env | State |\n| --- | --- |\n| stg | ok |",
        buttons: BUTTONS,
      }),
    );

    const posted = ops.postBlocks.mock.calls[0]![0];
    expect(posted.blocks.map((block) => (block as { type: string }).type)).toEqual([
      "markdown",
      "table",
      "actions",
    ]);
    expect(posted.blocks.at(-1)).toEqual({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "button_1",
          text: { type: "plain_text", text: "Approve" },
          value: "yes",
          style: "primary",
        },
        {
          type: "button",
          action_id: "button_2",
          text: { type: "plain_text", text: "Reject" },
          value: "no",
          style: undefined,
        },
      ],
    });
    expect(posted.text).toContain("Deploy v2?");
    expect((result.content[0] as { text: string }).text).toContain("123.456");
  });

  test.each([
    [false, "static_select"],
    [true, "multi_static_select"],
  ])("a menu with multiple=%s becomes a %s", async (multiple, type) => {
    const { tool, ops } = boundTool();

    await tool.execute(
      ...executeArgs({
        text: "Pick an environment",
        menu: {
          placeholder: "Environment",
          options: [
            { text: "Staging", value: "stg" },
            { text: "Production", value: "prod" },
          ],
          multiple,
        },
      }),
    );

    expect(ops.postBlocks.mock.calls[0]![0].blocks.at(-1)).toEqual({
      type: "actions",
      elements: [
        {
          type,
          action_id: "menu",
          placeholder: { type: "plain_text", text: "Environment" },
          options: [
            { text: { type: "plain_text", text: "Staging" }, value: "stg" },
            { text: { type: "plain_text", text: "Production" }, value: "prod" },
          ],
        },
      ],
    });
  });

  test("resolves mentions in the text as a normal reply does", async () => {
    const { tool, ops } = boundTool({
      resolveMentions: (text) => text.replace("<@alice>", "<@U0000000001>"),
    });

    await tool.execute(...executeArgs({ text: "<@alice> please confirm", buttons: BUTTONS }));

    expect(ops.postBlocks.mock.calls[0]![0].blocks[0]).toEqual({
      type: "markdown",
      text: "<@U0000000001> please confirm",
    });
  });

  test("refuses a message with nothing to click and says to reply normally", async () => {
    const { tool, ops } = boundTool();

    await expect(tool.execute(...executeArgs({ text: "| A |\n| - |\n| 1 |" }))).rejects.toThrow(
      /give `buttons` or `menu`.*reply normally/s,
    );
    expect(ops.postBlocks).not.toHaveBeenCalled();
  });

  test("refuses Block Kit JSON, which it took before, and says what to give instead", () => {
    const { raw } = boundTool();

    expect(() =>
      raw.prepareArguments?.({ label: "x", text: "t", blocks: [{ type: "markdown", text: "t" }] }),
    ).toThrow(/no longer takes Block Kit JSON.*`buttons` or `menu`/s);
    expect(raw.prepareArguments?.({ label: "x", text: "t", buttons: BUTTONS })).toEqual({
      label: "x",
      text: "t",
      buttons: BUTTONS,
    });
  });

  test("replaces a posted message, and without buttons removes them", async () => {
    const { tool, ops } = boundTool();

    const result = await tool.execute(
      ...executeArgs({ text: "Approved by the requester.", update_ts: "111.222" }),
    );

    expect(ops.updateBlocks).toHaveBeenCalledWith({
      ts: "111.222",
      text: "Approved by the requester.",
      blocks: [{ type: "markdown", text: "Approved by the requester." }],
    });
    expect(ops.postBlocks).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain("Updated");
  });

  test("refuses text too long to leave room for the buttons", async () => {
    const { tool, ops } = boundTool();
    const tables = Array.from({ length: 30 }, (_, i) => `t${i}\n\n| A |\n| - |\n| ${i} |`);

    await expect(
      tool.execute(...executeArgs({ text: tables.join("\n\n"), buttons: BUTTONS })),
    ).rejects.toThrow(/leaves no room for the buttons/);
    expect(ops.postBlocks).not.toHaveBeenCalled();
  });

  test("fails with a helpful error when not bound to Slack", async () => {
    const { tool } = createSlackBlockKitTool();
    await expect(
      callableTool(tool).execute(...executeArgs({ text: "t", buttons: BUTTONS })),
    ).rejects.toThrow("only available in Slack conversations");
  });

  test("surfaces Slack's validation detail", async () => {
    const slackError = Object.assign(new Error("An API error occurred: invalid_blocks"), {
      data: {
        ok: false,
        error: "invalid_blocks",
        response_metadata: { messages: ["[ERROR] must be less than 76 characters"] },
      },
    });
    const { tool } = boundTool({
      postBlocks: vi.fn(async () => {
        throw slackError;
      }),
    });

    const failure = await tool
      .execute(...executeArgs({ text: "t", buttons: BUTTONS }))
      .then(() => undefined, errorMessage);

    expect(failure).toContain("invalid_blocks");
    expect(failure).toContain("must be less than 76 characters");
  });
});

describe("slack tool pack", () => {
  test("declares slack_blockkit as a final-response tool", () => {
    const pack = createSlackToolPack(platformOps());

    expect(pack.finalResponseTools).toEqual(["slack_blockkit"]);
    expect(pack.tools.map((tool) => tool.name)).toEqual(["slack_blockkit"]);
  });

  test("posts into the run's conversation and thread, and is unavailable elsewhere", async () => {
    const ops = platformOps();
    const pack = createSlackToolPack(ops);
    const tool = onlyTool(pack);

    pack.bindRun({ conversationId: "C123", platformName: "slack", threadTs: "10.0" });
    await callableTool(tool).execute(...executeArgs({ text: "t", buttons: BUTTONS }));
    expect(ops.postBlocks).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({ text: "t", threadTs: "10.0" }),
    );

    pack.bindRun({ conversationId: "D999", platformName: "discord" });
    await expect(
      callableTool(tool).execute(...executeArgs({ text: "t", buttons: BUTTONS })),
    ).rejects.toThrow("only available in Slack conversations");
  });

  test("only updates messages posted by the tool in the bound conversation", async () => {
    const ops = platformOps({ postBlocks: vi.fn(async () => ({ ts: "owned-message" })) });
    const pack = createSlackToolPack(ops);
    const tool = onlyTool(pack);
    pack.bindRun({ conversationId: "C123", platformName: "slack" });

    await expect(
      callableTool(tool).execute(...executeArgs({ text: "t", update_ts: "foreign-message" })),
    ).rejects.toThrow("can only update messages posted by this tool");

    await callableTool(tool).execute(...executeArgs({ text: "t", buttons: BUTTONS }));
    await callableTool(tool).execute(
      ...executeArgs({ text: "updated", update_ts: "owned-message" }),
    );
    expect(ops.updateBlocks).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({ ts: "owned-message", text: "updated" }),
    );

    pack.bindRun({ conversationId: "C123", platformName: "slack", threadTs: "new-thread" });
    await expect(
      callableTool(tool).execute(...executeArgs({ text: "t", update_ts: "owned-message" })),
    ).rejects.toThrow("can only update messages posted by this tool");
  });

  test("updates a message the log says this tool posted before the process started", async () => {
    const ops = platformOps({
      ownsBlockKitMessage: vi.fn(
        (_conversationId, ts, threadTs) => ts === "owned-message" && threadTs === "original-thread",
      ),
    });
    const pack = createSlackToolPack(ops);
    pack.bindRun({ conversationId: "C123", platformName: "slack", threadTs: "original-thread" });

    await callableTool(onlyTool(pack)).execute(
      ...executeArgs({ text: "closed", update_ts: "owned-message" }),
    );

    expect(ops.updateBlocks).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({ ts: "owned-message", threadTs: "original-thread" }),
    );
  });
});
