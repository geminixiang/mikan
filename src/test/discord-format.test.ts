import { describe, expect, test } from "vitest";
import { formatDiscordMarkdown } from "../adapters/discord/format.js";
import { displayWidth, renderMonospaceTable } from "../adapters/markdown-tables.js";

describe("formatDiscordMarkdown", () => {
  test("fences a table as aligned columns", () => {
    const source = [
      "Findings:",
      "",
      "| Name | Verdict |",
      "| --- | --- |",
      "| Lin | guilty |",
      "",
    ].join("\n");

    const out = formatDiscordMarkdown(source);

    expect(out).toContain("Findings:");
    expect(out).toContain("```");
    expect(out).not.toContain("| --- |");
    expect(out).toContain("Name  Verdict");
  });

  test("leaves prose around a table exactly as written", () => {
    const source = [
      "## Result",
      "",
      "- **bold** item",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "> quoted tail",
    ].join("\n");

    const out = formatDiscordMarkdown(source);

    expect(out).toContain("## Result");
    expect(out).toContain("- **bold** item");
    expect(out).toContain("> quoted tail");
  });

  test("text with no table is returned unchanged", () => {
    const source = "Just prose with a `pipe | inside` inline code.";
    expect(formatDiscordMarkdown(source)).toBe(source);
  });

  test("a table too wide to align is left alone", () => {
    const wide = "x".repeat(80);
    const source = ["| A | B |", "| - | - |", `| ${wide} | ${wide} |`].join("\n");

    const out = formatDiscordMarkdown(source);

    expect(out).not.toContain("```");
    expect(out).toContain("| A | B |");
  });

  test("converts every table in a response, not just the first", () => {
    const table = ["| A | B |", "| - | - |", "| 1 | 2 |"].join("\n");
    const source = [table, "", "middle prose", "", table].join("\n");

    const out = formatDiscordMarkdown(source);

    expect(out.match(/```/g)).toHaveLength(4);
    expect(out).toContain("middle prose");
  });
});

const firstColumnWidth = (line: string): number =>
  displayWidth(line.slice(0, line.lastIndexOf("  ") + 2));

describe("constructs Discord cannot render", () => {
  test("a horizontal rule becomes a drawn line", () => {
    const out = formatDiscordMarkdown("above\n\n---\n\nbelow");
    expect(out).not.toMatch(/^-{3,}$/m);
    expect(out).toContain("─");
    expect(out).toContain("above");
    expect(out).toContain("below");
  });

  test.each([["***"], ["___"]])("%s is a rule too", (marker) => {
    expect(formatDiscordMarkdown(`a\n\n${marker}\n\nb`)).toContain("─");
  });

  test("an image becomes a bare URL, which Discord embeds", () => {
    const out = formatDiscordMarkdown("![範例圖片](https://example.com/a.png)");
    expect(out).not.toContain("![");
    expect(out).toContain("https://example.com/a.png");
    expect(out).toContain("範例圖片");
  });

  test("an image with no alt text emits only the URL", () => {
    expect(formatDiscordMarkdown("![](https://example.com/a.png)")).toBe(
      "https://example.com/a.png",
    );
  });

  test("a link that is not an image is left alone", () => {
    const source = "see [the docs](https://example.com)";
    expect(formatDiscordMarkdown(source)).toBe(source);
  });

  test("code samples keep whatever they contain", () => {
    const source = ["```md", "---", "![x](y.png)", "```"].join("\n");
    expect(formatDiscordMarkdown(source)).toBe(source);
  });

  test("a pipe inside code is not mistaken for a table", () => {
    const source = ["```js", "const a = b | c;", "```"].join("\n");
    expect(formatDiscordMarkdown(source)).toBe(source);
  });
});

describe("monospace alignment", () => {
  test("preserves fixed wide-range boundaries and supplementary code points", () => {
    const ranges = [
      [0x1100, 0x115f],
      [0x2e80, 0xa4cf],
      [0xac00, 0xd7a3],
      [0xf900, 0xfaff],
      [0xfe30, 0xfe6f],
      [0xff00, 0xff60],
      [0xffe0, 0xffe6],
      [0x1f300, 0x1faff],
      [0x2705, 0x2705],
      [0x270a, 0x270b],
      [0x2728, 0x2728],
      [0x274c, 0x274c],
      [0x274e, 0x274e],
      [0x2753, 0x2755],
      [0x2757, 0x2757],
      [0x2795, 0x2797],
      [0x27b0, 0x27b0],
      [0x27bf, 0x27bf],
    ];
    for (const [start, end] of ranges) {
      expect(displayWidth(String.fromCodePoint(start!, end!))).toBe(4);
      expect(displayWidth(String.fromCodePoint(start! - 1, end! + 1))).toBe(2);
    }
    expect(displayWidth("\u{20000}\ud800\u0301")).toBe(3);
  });

  test("counts CJK as two cells", () => {
    expect(displayWidth("項目")).toBe(4);
    expect(displayWidth("ab")).toBe(2);
    expect(displayWidth("項a")).toBe(3);
  });

  test("counts the verdict symbols a model actually writes as wide", () => {
    expect(displayWidth("✅")).toBe(2);
    expect(displayWidth("❌")).toBe(2);
  });

  test("aligns a CJK table to equal display width", () => {
    const rendered = renderMonospaceTable({
      headers: ["項目", "結果"],
      rows: [
        ["死亡時間", "正確"],
        ["兇手", "林秘書"],
      ],
      startLine: 0,
      endLine: 0,
    });

    const [header, , first, second] = rendered.split("\n");
    expect(firstColumnWidth(first ?? "")).toBe(firstColumnWidth(header ?? ""));
    expect(firstColumnWidth(second ?? "")).toBe(firstColumnWidth(header ?? ""));
  });

  test("pads a ragged row rather than dropping it", () => {
    const rendered = renderMonospaceTable({
      headers: ["A", "B", "C"],
      rows: [["1"]],
      startLine: 0,
      endLine: 0,
    });
    expect(rendered.split("\n")).toHaveLength(3);
    expect(rendered).toContain("1");
  });
});
