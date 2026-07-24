import { describe, expect, test } from "vitest";
import { renderSlackBlocks } from "../src/adapters/slack/blocks.js";

interface MarkdownBlockShape {
  type: "markdown";
  text: string;
}

function markdownTexts(blocks: ReturnType<typeof renderSlackBlocks>["blocks"]): string[] {
  return blocks.flatMap((block) =>
    block.type === "markdown" ? [(block as unknown as MarkdownBlockShape).text] : [],
  );
}

describe("renderSlackBlocks", () => {
  test("renders prose as a native markdown block, verbatim", () => {
    const source = "# Title\n\nParagraph with **bold**, `code`, and a [link](https://example.com).";
    const rendered = renderSlackBlocks(source);
    expect(rendered.blocks).toEqual([{ type: "markdown", text: source }]);
  });

  test("keeps bullets verbatim in the markdown block", () => {
    const rendered = renderSlackBlocks("- one\n- two");
    expect(rendered.blocks).toEqual([{ type: "markdown", text: "- one\n- two" }]);
  });

  test("converts markdown tables into Slack table blocks", () => {
    const rendered = renderSlackBlocks(
      "Skills\n\n| Skill | 位置 |\n|---|---|\n| `ai-news` | `/workspace/skills/ai-news/` |\n| `native-web-search` | `/workspace/skills/native-web-search/` |",
    );

    expect(rendered.blocks).toEqual([
      { type: "markdown", text: "Skills" },
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

  test("converts plus-separated markdown tables with plain-text cells", () => {
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
            { type: "raw_text", text: "eve@example.com" },
          ],
          [
            { type: "raw_text", text: "2" },
            { type: "raw_text", text: "U2" },
            { type: "raw_text", text: "Bob" },
            { type: "raw_text", text: "bob@example.com" },
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

  test("interleaves markdown and table blocks in document order", () => {
    const rendered = renderSlackBlocks(
      "Intro before.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nOutro after.",
    );
    expect(rendered.blocks.map((block) => block.type)).toEqual(["markdown", "table", "markdown"]);
    expect(markdownTexts(rendered.blocks)).toEqual(["Intro before.", "Outro after."]);
  });

  test("converts legacy Slack mrkdwn links to GFM links", () => {
    const rendered = renderSlackBlocks(
      "• Example item <https://example.com/issues/123|#123> / <https://example.com/video|video>",
    );

    expect(rendered.blocks).toEqual([
      {
        type: "markdown",
        text: "• Example item [#123](https://example.com/issues/123) / [video](https://example.com/video)",
      },
    ]);
  });

  test("converts spaced legacy link labels in a structured response", () => {
    const source = `Updated configuration:

- \`example/project\` *checks closed items only*
- Open items are excluded
- Exclude automated requests
- Compare against <https://example.com/issues/456#comment-789|Existing Portfolio> first
- Format each candidate as:

\`\`\`text
• [category] description <issue URL|#number> / <video URL|video>
\`\`\`

_Triggered by @requester_`;

    const rendered = renderSlackBlocks(source);
    const renderedText = markdownTexts(rendered.blocks).join("\n");

    const expectedLink = "[Existing Portfolio](https://example.com/issues/456#comment-789)";
    expect(renderedText).toContain(expectedLink);
    expect(renderedText).not.toContain("%7C");
    expect(renderedText).not.toContain("<https://example.com/issues/456#comment-789|");
    // non-http pseudo-links inside the fence are not link syntax and stay verbatim
    expect(renderedText).toContain("<issue URL|#number>");
    expect(renderedText).toContain("_Triggered by @requester_");
    expect(rendered.text).toContain("Existing Portfolio");
  });

  test("splits prose over the 12k markdown block limit at paragraph boundaries", () => {
    const paragraph = "word ".repeat(500).trim(); // ~2.5k chars
    const source = Array.from({ length: 6 }, (_, i) => `P${i} ${paragraph}`).join("\n\n"); // ~15k
    const rendered = renderSlackBlocks(source);

    expect(rendered.blocks.length).toBeGreaterThan(1);
    for (const text of markdownTexts(rendered.blocks)) {
      expect(text.length).toBeLessThanOrEqual(12000);
      // paragraph-boundary split: chunks start at a paragraph head, not mid-word
      expect(text.startsWith("P")).toBe(true);
    }
    expect(markdownTexts(rendered.blocks).join("\n\n")).toBe(source);
  });

  test("derives a plain-text fallback without markup", () => {
    const rendered = renderSlackBlocks(
      "# Heading\n\nSome **bold** text with [a link](https://example.com).",
    );
    expect(rendered.text).toContain("Heading");
    expect(rendered.text).toContain("Some bold text with a link.");
    expect(rendered.text).not.toContain("**");
    expect(rendered.text).not.toContain("](");
  });

  test("returns no blocks for blank source", () => {
    expect(renderSlackBlocks("").blocks).toEqual([]);
    expect(renderSlackBlocks("   \n  ").blocks).toEqual([]);
  });
});
