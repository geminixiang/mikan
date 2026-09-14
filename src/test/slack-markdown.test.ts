import { describe, expect, test } from "vitest";
import { normalizeSlackCurrencyBold } from "../adapters/slack/markdown.js";
import { renderSlackBlocks } from "../adapters/slack/blocks.js";

describe("Slack currency bold boundaries", () => {
  test.each(["總額：**$123.45**", "合計**$1,234.56，占 76%**", "金額：**$1"])(
    "separates the affected boundary, including partial streamed text: %s",
    (source) => {
      expect(normalizeSlackCurrencyBold(source)).toBe(source.replace("**$", " **$"));
      expect(normalizeSlackCurrencyBold(normalizeSlackCurrencyBold(source))).toBe(
        normalizeSlackCurrencyBold(source),
      );
    },
  );
  test.each([
    "總額： **$123.45**",
    "Total:**$123.45**",
    "總額：**123.45**",
    "總額：**USD 123.45**",
    "`總額：**$123.45**`",
    "```md\n總額：**$123.45**\n```",
    "    總額：**$123.45**",
    "[link](https://example.com/總額：**$123.45**)",
    "總額：\\*\\*$123.45**",
  ])("preserves unrelated formatting and literal code: %s", (source) => {
    expect(normalizeSlackCurrencyBold(source)).toBe(source);
  });
  test("keeps code intact while adapting surrounding list prose", () => {
    const source = "- 總額：**$123**\n- `總額：**$123**`\n- 合計：**$456**";
    expect(normalizeSlackCurrencyBold(source)).toBe(
      "- 總額： **$123**\n- `總額：**$123**`\n- 合計： **$456**",
    );
    expect(renderSlackBlocks("總額：**$123**").blocks).toEqual([
      { type: "markdown", text: "總額： **$123**" },
    ]);
  });
});
