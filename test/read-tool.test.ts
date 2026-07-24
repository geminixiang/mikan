import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HostExecutor } from "../src/sandbox/host.js";
import { createReadTool } from "../src/tools/read.js";
import { DEFAULT_MAX_LINES } from "../src/tools/truncate.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first.type !== "text" || first.text === undefined) {
    throw new Error(`Expected text content, got ${first.type}`);
  }
  return first.text;
}

describe("createReadTool", () => {
  let dir: string;
  const tool = createReadTool(new HostExecutor());

  test("keeps read-only operations parallelizable", () => {
    expect(tool.executionMode).toBeUndefined();
  });

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-read-test-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("reads a small text file without truncation", async () => {
    const path = join(dir, "hello.txt");
    writeFileSync(path, "line one\nline two\n");
    const result = await tool.execute("1", { label: "read", path });
    expect(textOf(result)).toContain("line one");
    expect(textOf(result)).toContain("line two");
    expect(result.details).toBeUndefined();
  });

  test("throws for a missing file", async () => {
    await expect(
      tool.execute("1", { label: "read", path: join(dir, "nope.txt") }),
    ).rejects.toThrow();
  });

  test("reads from a 1-indexed offset", async () => {
    const path = join(dir, "lines.txt");
    writeFileSync(path, Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
    const result = await tool.execute("1", { label: "read", path, offset: 5 });
    const text = textOf(result);
    expect(text.startsWith("l5")).toBe(true);
    expect(text).toContain("l10");
    expect(text).not.toContain("l4\n");
  });

  test("throws when offset is beyond end of file", async () => {
    const path = join(dir, "short.txt");
    writeFileSync(path, "a\nb\n");
    await expect(tool.execute("1", { label: "read", path, offset: 100 })).rejects.toThrow(
      /beyond end of file/,
    );
  });

  test("applies a user limit and points at the next offset", async () => {
    const path = join(dir, "limited.txt");
    writeFileSync(path, Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
    const result = await tool.execute("1", { label: "read", path, limit: 3 });
    const text = textOf(result);
    expect(text).toContain("l3");
    expect(text).not.toContain("l4");
    expect(text).toMatch(/more lines in file\. Use offset=4 to continue/);
  });

  test("omits the continuation notice when the limit covers the whole file", async () => {
    const path = join(dir, "covered.txt");
    writeFileSync(path, "a\nb\n");
    const result = await tool.execute("1", { label: "read", path, limit: 100 });
    expect(textOf(result)).not.toContain("more lines in file");
  });

  test("truncates by line count and reports the next offset", async () => {
    const path = join(dir, "big.txt");
    const totalLines = DEFAULT_MAX_LINES + 500;
    writeFileSync(path, Array.from({ length: totalLines }, (_, i) => `line-${i + 1}`).join("\n"));
    const result = await tool.execute("1", { label: "read", path });
    const text = textOf(result);
    expect(text).toContain(`line-${DEFAULT_MAX_LINES}`);
    expect(text).not.toContain(`line-${DEFAULT_MAX_LINES + 1}\n`);
    expect(text).toContain(`Use offset=${DEFAULT_MAX_LINES + 1} to continue`);
    expect(result.details?.truncation?.truncated).toBe(true);
    expect(result.details?.truncation?.truncatedBy).toBe("lines");
  });

  test("truncates by byte size for wide files", async () => {
    const path = join(dir, "wide.txt");
    // 100 lines x ~1KB stays under the line limit but blows the 50KB byte limit
    writeFileSync(path, Array.from({ length: 100 }, () => "x".repeat(1024)).join("\n"));
    const result = await tool.execute("1", { label: "read", path });
    expect(result.details?.truncation?.truncated).toBe(true);
    expect(result.details?.truncation?.truncatedBy).toBe("bytes");
    expect(textOf(result)).toMatch(/limit\)\. Use offset=\d+ to continue/);
  });

  test("directs the model to bash when a single line exceeds the byte limit", async () => {
    const path = join(dir, "oneline.txt");
    writeFileSync(path, "a".repeat(60_000));
    const result = await tool.execute("1", { label: "read", path });
    const text = textOf(result);
    expect(text).toContain("exceeds");
    expect(text).toContain("sed -n '1p'");
    expect(result.details?.truncation?.firstLineExceedsLimit).toBe(true);
  });

  test("returns images as base64 attachments", async () => {
    const path = join(dir, "pic.png");
    writeFileSync(path, Buffer.from("fake image bytes"));
    const result = await tool.execute("1", { label: "read", path });
    expect(textOf(result)).toContain("image/png");
    const image = result.content[1];
    expect(image.type).toBe("image");
    if (image.type === "image") {
      expect(image.mimeType).toBe("image/png");
      expect(Buffer.from(image.data, "base64").toString("utf-8")).toBe("fake image bytes");
    }
  });

  test("detects image extensions case-insensitively", async () => {
    const path = join(dir, "photo.JPEG");
    writeFileSync(path, Buffer.from("jpeg bytes"));
    const result = await tool.execute("1", { label: "read", path });
    expect(textOf(result)).toContain("image/jpeg");
  });

  test("throws when an image file cannot be read", async () => {
    await expect(
      tool.execute("1", { label: "read", path: join(dir, "missing.png") }),
    ).rejects.toThrow();
  });

  test("handles paths containing shell metacharacters", async () => {
    const path = join(dir, "we ird '$(name)'.txt");
    writeFileSync(path, "safe content\n");
    const result = await tool.execute("1", { label: "read", path });
    expect(textOf(result)).toContain("safe content");
  });
});
