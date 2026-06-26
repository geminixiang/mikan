import { describe, expect, test } from "vitest";
import { renderSlackBlocks } from "../src/adapters/slack/blocks.js";

describe("renderSlackBlocks", () => {
  test("converts markdown tables into Slack table blocks", () => {
    const rendered = renderSlackBlocks(
      "Skills\n\n| Skill | 位置 |\n|---|---|\n| `ai-news` | `/workspace/skills/ai-news/` |\n| `native-web-search` | `/workspace/skills/native-web-search/` |",
    );

    expect(rendered.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Skills" } },
      {
        type: "table",
        rows: [
          [
            { type: "raw_text", text: "#" },
            { type: "raw_text", text: "Skill" },
            { type: "raw_text", text: "位置" },
          ],
          [
            { type: "raw_text", text: "1" },
            { type: "raw_text", text: "ai-news" },
            { type: "raw_text", text: "/workspace/skills/ai-news/" },
          ],
          [
            { type: "raw_text", text: "2" },
            { type: "raw_text", text: "native-web-search" },
            { type: "raw_text", text: "/workspace/skills/native-web-search/" },
          ],
        ],
        column_settings: [{ is_wrapped: true }, { is_wrapped: true }, { is_wrapped: true }],
      },
    ]);
  });

  test("converts wide markdown tables into Slack table blocks", () => {
    const rendered = renderSlackBlocks(
      "| 產品 | 分類 | 價格 | 庫存 | 評分 |\n|---|---|---|---|---|\n| AirPods | 耳機 | 249 | 1280 | 4.7 |\n| Kindle | 閱讀器 | 419 | 890 | 4.5 |",
    );

    expect(rendered.blocks).toEqual([
      {
        type: "table",
        rows: [
          [
            { type: "raw_text", text: "#" },
            { type: "raw_text", text: "產品" },
            { type: "raw_text", text: "分類" },
            { type: "raw_text", text: "價格" },
            { type: "raw_text", text: "庫存" },
            { type: "raw_text", text: "評分" },
          ],
          [
            { type: "raw_text", text: "1" },
            { type: "raw_text", text: "AirPods" },
            { type: "raw_text", text: "耳機" },
            { type: "raw_text", text: "249" },
            { type: "raw_text", text: "1280" },
            { type: "raw_text", text: "4.7" },
          ],
          [
            { type: "raw_text", text: "2" },
            { type: "raw_text", text: "Kindle" },
            { type: "raw_text", text: "閱讀器" },
            { type: "raw_text", text: "419" },
            { type: "raw_text", text: "890" },
            { type: "raw_text", text: "4.5" },
          ],
        ],
        column_settings: [
          { is_wrapped: true },
          { is_wrapped: true },
          { is_wrapped: true },
          { is_wrapped: true },
          { is_wrapped: true },
          { is_wrapped: true },
        ],
      },
    ]);
  });

  test("converts plus-separated markdown tables into fields", () => {
    const rendered = renderSlackBlocks(
      "| id | name | email |\n|----+------+-------|\n| U1 | Eve | eve@example.com |\n| U2 | Bob | bob@example.com |",
    );

    expect(rendered.blocks).toEqual([
      {
        type: "table",
        rows: [
          [
            { type: "raw_text", text: "#" },
            { type: "raw_text", text: "id" },
            { type: "raw_text", text: "name" },
            { type: "raw_text", text: "email" },
          ],
          [
            { type: "raw_text", text: "1" },
            { type: "raw_text", text: "U1" },
            { type: "raw_text", text: "Eve" },
            { type: "raw_text", text: "<mailto:eve@example.com|eve@example.com>" },
          ],
          [
            { type: "raw_text", text: "2" },
            { type: "raw_text", text: "U2" },
            { type: "raw_text", text: "Bob" },
            { type: "raw_text", text: "<mailto:bob@example.com|bob@example.com>" },
          ],
        ],
        column_settings: [
          { is_wrapped: true },
          { is_wrapped: true },
          { is_wrapped: true },
          { is_wrapped: true },
        ],
      },
    ]);
  });

  test("keeps bullets as Slack mrkdwn sections", () => {
    const rendered = renderSlackBlocks("- one\n- two");
    expect(rendered.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "• one\n• two" } },
    ]);
  });
});
