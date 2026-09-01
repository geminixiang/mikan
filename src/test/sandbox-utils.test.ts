import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HostExecutor } from "../sandbox/host.js";
import {
  execReadFile,
  execSimple,
  execWriteFile,
  killProcessTree,
  shellEscape,
} from "../sandbox/utils.js";

describe("shellEscape", () => {
  test("wraps plain strings in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  test("escapes embedded single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  test("keeps shell metacharacters literal through a real shell", async () => {
    const tricky = `$(touch /tmp/pwn) \`id\` "; rm -rf ~" 'quoted' \\backslash`;
    const result = await new HostExecutor().exec(`printf '%s' ${shellEscape(tricky)}`);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(tricky);
  });
});

describe("HostExecutor", () => {
  test("decodes UTF-8 characters split across output chunks", async () => {
    const command =
      "node -e 'process.stdout.write(Buffer.from([0xe4, 0xb8])); setTimeout(() => process.stdout.write(Buffer.from([0xad])), 30)'";
    const result = await new HostExecutor().exec(command);

    expect(result.stdout).toBe("中");
  });
});

describe("execSimple", () => {
  test("resolves with stdout on success", async () => {
    await expect(execSimple("echo", ["hi"])).resolves.toBe("hi\n");
  });

  test("rejects with stderr on failure", async () => {
    await expect(execSimple("sh", ["-c", "echo bad >&2; exit 2"])).rejects.toThrow(/bad/);
  });

  test("rejects with the exit code when stderr is empty", async () => {
    await expect(execSimple("sh", ["-c", "exit 7"])).rejects.toThrow(/Exit code 7/);
  });
});

describe("killProcessTree", () => {
  test("kills a detached process group", async () => {
    const child = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    const closed = new Promise<string | null>((resolve) => {
      child.on("close", (_code, signal) => resolve(signal));
    });
    killProcessTree(child.pid!);
    expect(await closed).toBe("SIGKILL");
  });

  test("ignores already-dead processes", () => {
    expect(() => killProcessTree(2 ** 30)).not.toThrow();
  });
});

describe("execReadFile / execWriteFile", () => {
  let dir: string;
  const executor = new HostExecutor();

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-sbx-utils-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("round-trips content with quotes, unicode, and newlines", async () => {
    const path = join(dir, "nested", "deep", "file.txt");
    const content = "héllo 🍊 'single' \"double\" $VAR `tick`\nline two\n";
    await execWriteFile(executor, path, content);
    await expect(execReadFile(executor, path)).resolves.toBe(content);
  });

  test("writes empty files", async () => {
    const path = join(dir, "empty.txt");
    await execWriteFile(executor, path, "");
    await expect(execReadFile(executor, path)).resolves.toBe("");
  });

  test("chunks large content and leaves no staging files behind", async () => {
    const path = join(dir, "large.bin");
    // ~150KB of content encodes to >196K base64 chars: several 64K chunks
    const content = "abcdefghij".repeat(15_000);
    await execWriteFile(executor, path, content);
    await expect(execReadFile(executor, path)).resolves.toBe(content);
    expect(readdirSync(dir)).toEqual(["large.bin"]);
  });

  test("execReadFile throws for missing files", async () => {
    await expect(execReadFile(executor, join(dir, "missing.txt"))).rejects.toThrow();
  });

  test("execWriteFile throws when the destination is unwritable", async () => {
    writeFileSync(join(dir, "blocker"), "");
    await expect(
      execWriteFile(executor, join(dir, "blocker", "child.txt"), "content"),
    ).rejects.toThrow();
  });
});
