import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TODO_CONTEXT } from "@earendil-works/pi-agent-core";
import { HostExecutor } from "../sandbox/host.js";
import type { Executor } from "../sandbox/index.js";
import { execReadFile, execReadFileBase64, execWriteFile } from "../sandbox/utils.js";
import { createSandboxExecutionEnv } from "../harness/execution-env.js";

/**
 * Contract test for the sandbox-backed `ExecutionEnv`: an exec-only executor
 * (the container/cloudflare shape) is wrapped and driven through pi's
 * FileSystem/Shell surface, including the no-throw `Result` invariant.
 */

function onlyShellEnv(dir: string) {
  const host = new HostExecutor();
  const executor: Executor = {
    exec: (command, options) => host.exec(command, options),
    readFile: (path, options) => execReadFile(host, path, options),
    readFileBase64: (path, options) => execReadFileBase64(host, path, options),
    writeFile: (path, content, options) => execWriteFile(host, path, content, options),
    getWorkspacePath: () => dir,
    getPathContext: () => ({ hostWorkspaceRoot: dir, runtimeWorkspaceRoot: dir }),
    getSandboxConfig: () => ({ type: "container", container: "test" }),
  };
  return createSandboxExecutionEnv(executor, "container", dir);
}

describe("sandbox execution env", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-exec-env-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("resolves relative paths against the runtime workspace root", async () => {
    const env = onlyShellEnv(dir);
    expect(await env.absolutePath("a.txt", TODO_CONTEXT)).toEqual({
      ok: true,
      value: join(dir, "a.txt"),
    });
    expect(await env.absolutePath("/etc/hosts", TODO_CONTEXT)).toEqual({
      ok: true,
      value: "/etc/hosts",
    });
  });

  test("round-trips shell-hostile content", async () => {
    const env = onlyShellEnv(dir);
    const content = `it's "$HOME" \`whoami\` 100%\n\\n not a newline\n橘子 🍊\n`;
    const path = join(dir, "config.sh");

    expect((await env.writeFile(path, content, TODO_CONTEXT)).ok).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(content);
    expect(await env.readTextFile(path, TODO_CONTEXT)).toEqual({ ok: true, value: content });
  });

  test("reads binary files as bytes", async () => {
    const env = onlyShellEnv(dir);
    const path = join(dir, "blob.bin");
    writeFileSync(path, Buffer.from([0, 1, 2, 253, 254, 255]));
    const result = await env.readBinaryFile(path, TODO_CONTEXT);
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.value]).toEqual([0, 1, 2, 253, 254, 255]);
  });

  test("fileInfo reports kind and size; missing paths return not_found", async () => {
    const env = onlyShellEnv(dir);
    const path = join(dir, "file.txt");
    writeFileSync(path, "hello");

    const info = await env.fileInfo(path, TODO_CONTEXT);
    expect(info.ok).toBe(true);
    if (info.ok) {
      expect(info.value.kind).toBe("file");
      expect(info.value.size).toBe(5);
      expect(info.value.name).toBe("file.txt");
    }

    const missing = await env.fileInfo(join(dir, "nope.txt"), TODO_CONTEXT);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("not_found");
  });

  test("exists, createDir, listDir, renameFile, remove, canonicalPath", async () => {
    const env = onlyShellEnv(dir);
    const nested = join(dir, "a", "b");
    expect((await env.createDir(nested, { recursive: true }, TODO_CONTEXT)).ok).toBe(true);
    expect(await env.exists(nested, TODO_CONTEXT)).toEqual({ ok: true, value: true });

    const from = join(nested, "from.txt");
    await env.writeFile(from, "x", TODO_CONTEXT);
    const to = join(nested, "to.txt");
    expect((await env.renameFile(from, to, TODO_CONTEXT)).ok).toBe(true);
    expect(await env.exists(from, TODO_CONTEXT)).toEqual({ ok: true, value: false });

    const entries = await env.listDir(join(dir, "a"), TODO_CONTEXT);
    expect(entries.ok).toBe(true);
    if (entries.ok) {
      expect(entries.value.map((entry) => entry.name)).toContain("b");
      expect(entries.value.find((entry) => entry.name === "b")?.kind).toBe("directory");
    }

    const canonical = await env.canonicalPath(to, TODO_CONTEXT);
    expect(canonical.ok).toBe(true);

    expect((await env.remove(join(dir, "a"), { recursive: true }, TODO_CONTEXT)).ok).toBe(true);
    expect(await env.exists(join(dir, "a"), TODO_CONTEXT)).toEqual({ ok: true, value: false });
    expect(await env.exists(join(dir, "missing"), TODO_CONTEXT)).toEqual({
      ok: true,
      value: false,
    });
  });

  test("never throws: a missing read is an err Result", async () => {
    const env = onlyShellEnv(dir);
    const result = await env.readTextFile(join(dir, "missing.txt"), TODO_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  test("exec returns the exit code and combined output", async () => {
    const env = onlyShellEnv(dir);
    const okResult = await env.exec("echo hello", {}, TODO_CONTEXT);
    expect(okResult.ok).toBe(true);
    if (okResult.ok) {
      expect(okResult.value.exitCode).toBe(0);
      expect(okResult.value.truncation.truncated).toBe(false);
    }

    const failure = await env.exec("exit 3", {}, TODO_CONTEXT);
    expect(failure.ok).toBe(true);
    if (failure.ok) expect(failure.value.exitCode).toBe(3);
  });

  test("exec truncates to the tail and spills the full output", async () => {
    const env = onlyShellEnv(dir);
    const updates: string[] = [];
    const result = await env.exec(
      "seq 1 5000",
      {
        capture: { limits: { maxLines: 10, maxBytes: 1_000_000, retain: "tail" }, spill: true },
        onUpdate: (update) => {
          if (update.kind === "replace") updates.push(update.output.text);
        },
      },
      TODO_CONTEXT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncation.truncated).toBe(true);
    expect(result.value.spillPath).toBeTruthy();
    expect(updates.length).toBe(1);
    expect(updates[0]).toContain("5000");

    const spilled = await env.readTextFile(result.value.spillPath!, TODO_CONTEXT);
    expect(spilled.ok).toBe(true);
    if (spilled.ok) expect(spilled.value.trimEnd().split("\n").at(-1)).toBe("5000");
  });
});
