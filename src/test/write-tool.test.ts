import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HostExecutor } from "../sandbox/host.js";
import { createWriteTool } from "../tools/write.js";

describe("createWriteTool", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-test-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("serializes file writes", () => {
    expect(createWriteTool(new HostExecutor()).executionMode).toBe("sequential");
  });

  test("writes content exactly, creating parent directories", async () => {
    const tool = createWriteTool(new HostExecutor());
    const path = join(dir, "nested", "deep", "test.txt");
    const content = "hello 'quoted' $VAR `tick` \\backslash\nsecond line";
    const result = await tool.execute("1", { label: "write config", path, content });
    expect(result.content[0].text).toContain("test.txt");
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  test("overwrites existing files", async () => {
    const tool = createWriteTool(new HostExecutor());
    const path = join(dir, "test.txt");
    writeFileSync(path, "old");
    await tool.execute("1", { label: "write", path, content: "new content" });
    expect(readFileSync(path, "utf-8")).toBe("new content");
  });

  test("throws on unwritable destination", async () => {
    const tool = createWriteTool(new HostExecutor());
    writeFileSync(join(dir, "blocker"), "");
    await expect(
      tool.execute("1", {
        label: "write config",
        path: join(dir, "blocker", "child.txt"),
        content: "hello",
      }),
    ).rejects.toThrow();
  });
});
