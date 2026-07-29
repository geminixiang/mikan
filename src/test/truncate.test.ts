import { describe, expect, test } from "vitest";
import { formatSize, truncateHead, truncateTail } from "../tools/truncate.js";

describe("formatSize", () => {
  test("formats bytes", () => {
    expect(formatSize(512)).toBe("512B");
  });

  test("formats kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0KB");
    expect(formatSize(1536)).toBe("1.5KB");
  });

  test("formats megabytes", () => {
    expect(formatSize(1048576)).toBe("1.0MB");
    expect(formatSize(3145728)).toBe("3.0MB");
  });
});

describe("truncateHead", () => {
  test("returns untruncated when content fits limits", () => {
    const result = truncateHead("hello\nworld", { maxLines: 10, maxBytes: 1024 });
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("hello\nworld");
  });

  test("truncates by line count", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const result = truncateHead(lines.join("\n"), { maxLines: 5, maxBytes: 999999 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    expect(result.outputLines).toBe(5);
  });

  test("truncates by byte limit", () => {
    const result = truncateHead("short\n" + "a".repeat(100), { maxLines: 100, maxBytes: 50 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
  });

  test("returns empty when first line exceeds byte limit", () => {
    const result = truncateHead("x".repeat(100), { maxLines: 100, maxBytes: 50 });
    expect(result.truncated).toBe(true);
    expect(result.content).toBe("");
    expect(result.firstLineExceedsLimit).toBe(true);
  });

  test("uses default limits when options are empty", () => {
    const result = truncateHead("hello");
    expect(result.truncated).toBe(false);
  });

  test("handles empty content", () => {
    const result = truncateHead("", { maxLines: 10, maxBytes: 1024 });
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("");
  });

  test("truncates multi-byte UTF-8 from head", () => {
    const content = "a".repeat(100) + "\u4e2d\u56fd"; // 100 ascii + 2 chinese chars (6 bytes)
    const result = truncateHead(content, { maxLines: 100, maxBytes: 50 });
    expect(result.truncated).toBe(true);
  });
});

describe("truncateTail", () => {
  test("returns untruncated when content fits limits", () => {
    const result = truncateTail("hello\nworld", { maxLines: 10, maxBytes: 1024 });
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("hello\nworld");
  });

  test("truncates by line count (keeps last lines)", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const result = truncateTail(lines.join("\n"), { maxLines: 3, maxBytes: 999999 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("lines");
    expect(result.outputLines).toBe(3);
    expect(result.content).toBe("line 8\nline 9\nline 10");
  });

  test("truncates by byte limit (keeps end)", () => {
    const content = "prefix\n" + "a".repeat(200);
    const result = truncateTail(content, { maxLines: 100, maxBytes: 50 });
    expect(result.truncated).toBe(true);
    expect(result.truncatedBy).toBe("bytes");
  });

  test("returns partial last line when single line exceeds byte limit", () => {
    const longLine = "x".repeat(200);
    const result = truncateTail(longLine, { maxLines: 100, maxBytes: 50 });
    expect(result.truncated).toBe(true);
    expect(result.lastLinePartial).toBe(true);
    expect(result.content.length).toBeLessThan(200);
  });

  test("handles empty content", () => {
    const result = truncateTail("", { maxLines: 10, maxBytes: 1024 });
    expect(result.truncated).toBe(false);
    expect(result.content).toBe("");
  });

  test("uses default limits when options are empty", () => {
    const result = truncateTail("hello");
    expect(result.truncated).toBe(false);
  });

  test("handles multi-byte UTF-8 boundary in tail truncation", () => {
    // "中" is 3 bytes in UTF-8 (E4 B8 AD). Truncating to 1 byte lands mid-character.
    const content = "prefix\n中國";
    const result = truncateTail(content, { maxLines: 100, maxBytes: 2 });
    expect(result.truncated).toBe(true);
    expect(result.lastLinePartial || result.truncatedBy).toBeTruthy();
  });
});
