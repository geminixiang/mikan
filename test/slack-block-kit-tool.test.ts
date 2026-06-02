import { describe, expect, test, vi } from "vitest";
import { createSlackBlockKitTool } from "../src/adapters/slack/tools/block-kit.js";

describe("slack_blockkit tool", () => {
  test("accepts multi_static_select in section.accessory", async () => {
    const { tool, setBlockKitResponseFunction } = createSlackBlockKitTool();
    const respond = vi.fn().mockResolvedValue(undefined);
    setBlockKitResponseFunction(respond);

    await tool.execute("call-1", {
      label: "multi select",
      text: "Choose options",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Choose options" },
          accessory: {
            type: "multi_static_select",
            action_id: "choose_options",
            placeholder: { type: "plain_text", text: "Choose" },
            options: [{ text: { type: "plain_text", text: "A" }, value: "a" }],
          },
        },
      ],
    });

    expect(respond).toHaveBeenCalledWith({
      text: "Choose options",
      blocks: expect.arrayContaining([expect.objectContaining({ type: "section" })]),
    });
  });

  test("rejects multi_static_select in actions.elements with placement hint", async () => {
    const { tool, setBlockKitResponseFunction } = createSlackBlockKitTool();
    setBlockKitResponseFunction(vi.fn().mockResolvedValue(undefined));

    await expect(
      tool.execute("call-1", {
        label: "multi select",
        text: "Choose options",
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "multi_static_select",
                action_id: "choose_options",
                placeholder: { type: "plain_text", text: "Choose" },
                options: [{ text: { type: "plain_text", text: "A" }, value: "a" }],
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow("section.accessory");
  });
});
