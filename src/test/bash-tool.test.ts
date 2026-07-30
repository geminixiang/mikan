import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HostExecutor } from "../sandbox/host.js";
import type { Executor } from "../sandbox/index.js";
import { createBashTool } from "../tools/bash.js";
import { DEFAULT_MAX_LINES } from "@earendil-works/pi-agent-core";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first.type !== "text" || first.text === undefined) {
    throw new Error(`Expected text content, got ${first.type}`);
  }
  return first.text;
}

describe("createBashTool", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-bash-test-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("serializes command execution", () => {
    expect(createBashTool(new HostExecutor()).executionMode).toBe("sequential");
  });

  test("returns stdout of a successful command", async () => {
    const tool = createBashTool(new HostExecutor());
    const result = await tool.execute("1", { label: "echo", command: "echo hello" });
    expect(textOf(result)).toContain("hello");
    expect(result.details).toBeUndefined();
  });

  test("combines stdout and stderr", async () => {
    const tool = createBashTool(new HostExecutor());
    const result = await tool.execute("1", {
      label: "both streams",
      command: "echo out; echo err >&2",
    });
    const text = textOf(result);
    expect(text).toContain("out");
    expect(text).toContain("err");
  });

  test("reports '(no output)' for silent commands", async () => {
    const tool = createBashTool(new HostExecutor());
    const result = await tool.execute("1", { label: "silent", command: "true" });
    expect(textOf(result)).toBe("(no output)");
  });

  test("throws on non-zero exit, including output and exit code", async () => {
    const tool = createBashTool(new HostExecutor());
    await expect(
      tool.execute("1", { label: "fail", command: "echo boom; exit 3" }),
    ).rejects.toThrow(/boom[\s\S]*Command exited with code 3/);
  });

  test("spills oversized output into the workspace and reports the path", async () => {
    const tool = createBashTool(new HostExecutor(), { hostWorkspaceRoot: dir });
    // seq 1..30000 is ~170KB over 30000 lines: exceeds both line and byte limits
    const result = await tool.execute("1", { label: "big", command: "seq 1 30000" });
    const text = textOf(result);

    expect(result.details?.truncation?.truncated).toBe(true);
    const spillPath = result.details?.fullOutputPath;
    expect(spillPath).toBeDefined();
    expect(spillPath).toContain(join(dir, ".mikan", "bash-output"));
    expect(text).toContain(`Full output: ${spillPath}`);

    // The truncated view keeps the tail; the spill file holds everything
    expect(text).toContain("30000");
    expect(text).not.toContain("\n1\n");
    const full = readFileSync(spillPath!, "utf-8");
    expect(full.startsWith("1\n")).toBe(true);
    expect(full).toContain("\n30000");
    expect(result.details?.truncation?.outputLines).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
  });

  test("notes when spilling the full output fails", async () => {
    const host = new HostExecutor();
    const failingWrites: Executor = {
      exec: (cmd, opts) => host.exec(cmd, opts),
      readFile: (path, opts) => host.readFile(path, opts),
      writeFile: async () => {
        throw new Error("disk full");
      },
      getWorkspacePath: (p) => host.getWorkspacePath(p),
      getPathContext: (root) => host.getPathContext(root),
    };
    const tool = createBashTool(failingWrites, { hostWorkspaceRoot: dir });
    const result = await tool.execute("1", { label: "big", command: "seq 1 30000" });
    expect(result.details?.fullOutputPath).toBeUndefined();
    expect(textOf(result)).toContain("Full output unavailable (spill failed).");
  });

  test("truncates by line count without spilling when output is small in bytes", async () => {
    const tool = createBashTool(new HostExecutor(), { hostWorkspaceRoot: dir });
    // 3000 one-character lines: over the line limit, well under 50KB
    const result = await tool.execute("1", { label: "lines", command: "yes x | head -n 3000" });
    expect(result.details?.truncation?.truncatedBy).toBe("lines");
    expect(result.details?.fullOutputPath).toBeUndefined();
    // pi-agent-core's line counting ignores the trailing newline (wc -l semantics)
    expect(textOf(result)).toMatch(/Showing lines 1001-3000 of 3000\./);
    expect(existsSync(join(dir, ".mikan"))).toBe(false);
  });

  test("kills commands that exceed the timeout", async () => {
    const tool = createBashTool(new HostExecutor());
    await expect(
      tool.execute("1", { label: "slow", command: "sleep 10", timeout: 1 }),
    ).rejects.toThrow(/timed out/);
  }, 15_000);
});
