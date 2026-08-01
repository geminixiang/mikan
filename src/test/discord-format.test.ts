import { describe, expect, test } from "vitest";
import { formatDiscordMarkdown } from "../adapters/discord/format.js";
import { displayWidth, renderMonospaceTable } from "../adapters/markdown-tables.js";

/**
 * Discord renders every construct mikan emits except tables, which arrive as a
 * wall of literal pipes and dashes. The model keeps writing standard markdown
 * for every platform; this is the last step before sending, where the parts
 * Discord cannot render become something it can.
 */
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
    // Columns padded to a common width, so the fence lays them out.
    expect(out).toContain("Name  Verdict");
  });

  test("leaves prose around a table exactly as written", () => {
    // Prose is sliced verbatim rather than re-serialized, so everything
    // Discord already renders correctly survives untouched.
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
    // Discord soft-wraps inside a fence, and a wrapped table scatters its
    // columns — worse than the pipes it was meant to replace.
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

describe("monospace alignment", () => {
  /**
   * Padding by code-point count misaligns a Chinese table badly enough that
   * the result reads worse than the raw pipes — which would defeat the point.
   */
  test("counts CJK as two cells", () => {
    expect(displayWidth("項目")).toBe(4);
    expect(displayWidth("ab")).toBe(2);
    expect(displayWidth("項a")).toBe(3);
  });

  test("counts the verdict symbols a model actually writes as wide", () => {
    // ✅ and ❌ carry most verdict columns; treating them as one cell drifts
    // the alignment of exactly the tables this exists for.
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
    // Every row's first column occupies the same number of cells, which is
    // what makes the fence render as columns rather than a ragged list.
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
