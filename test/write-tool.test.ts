import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createWriteTool } from "../src/tools/write.js";

function makeExecutor() {
  const exec = vi.fn();
  return { exec };
}

describe("createWriteTool", () => {
  let dir: string;
  let executor: ReturnType<typeof makeExecutor>;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    executor = makeExecutor();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("writes file content via executor", async () => {
    executor.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const tool = createWriteTool(executor);
    const result = await tool.execute("1", {
      label: "write config",
      path: join(dir, "test.txt"),
      content: "hello",
    });
    expect(result.content[0].text).toContain("Successfully wrote 5 bytes to");
    expect(result.content[0].text).toContain("test.txt");
    expect(executor.exec).toHaveBeenCalledTimes(1);
  });

  test("throws on executor failure", async () => {
    executor.exec.mockResolvedValue({ code: 1, stdout: "", stderr: "permission denied" });
    const tool = createWriteTool(executor);
    await expect(
      tool.execute("1", {
        label: "write config",
        path: join(dir, "test.txt"),
        content: "hello",
      }),
    ).rejects.toThrow(/permission denied/);
  });

  test("throws when stderr is empty but code is non-zero", async () => {
    executor.exec.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    const tool = createWriteTool(executor);
    await expect(
      tool.execute("1", {
        label: "write config",
        path: join(dir, "test.txt"),
        content: "hello",
      }),
    ).rejects.toThrow(/Failed to write file/);
  });

  test("passes signal to executor", async () => {
    executor.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const abortController = new AbortController();
    const tool = createWriteTool(executor);
    await tool.execute(
      "1",
      {
        label: "write config",
        path: join(dir, "test.txt"),
        content: "hello",
      },
      abortController.signal,
    );
    expect(executor.exec).toHaveBeenCalledWith(expect.any(String), {
      signal: abortController.signal,
    });
  });
});
