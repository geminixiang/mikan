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
  linkAbortSignal,
  SandboxError,
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

  test("aborting a live signal kills the command and rejects", async () => {
    const controller = new AbortController();
    const running = new HostExecutor().exec("sleep 30", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    await expect(running).rejects.toThrow(/Command aborted/);
  });

  test("a signal that is already aborted rejects without waiting", async () => {
    await expect(
      new HostExecutor().exec("sleep 30", { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/Command aborted/);
  });

  test("a command that outlives its timeout rejects with the elapsed limit", async () => {
    await expect(new HostExecutor().exec("sleep 30", { timeout: 0.1 })).rejects.toThrow(
      /Command timed out after 0.1 seconds/,
    );
  });
});

describe("linkAbortSignal", () => {
  test("is inert without a signal", () => {
    let fired = 0;
    const unlink = linkAbortSignal(undefined, () => fired++);
    expect(fired).toBe(0);
    expect(() => unlink()).not.toThrow();
    expect(fired).toBe(0);
  });

  test("fires immediately for an already-aborted signal", () => {
    const controller = new AbortController();
    controller.abort();
    let fired = 0;

    const unlink = linkAbortSignal(controller.signal, () => fired++);

    expect(fired).toBe(1);
    // Nothing was subscribed, so unlinking must neither throw nor re-run it.
    expect(() => unlink()).not.toThrow();
    expect(fired).toBe(1);
  });

  test("forwards an abort that arrives later", () => {
    const controller = new AbortController();
    let fired = 0;

    linkAbortSignal(controller.signal, () => fired++);
    expect(fired).toBe(0);

    controller.abort();
    expect(fired).toBe(1);
  });

  test("unlinking drops the listener, so a later abort is ignored", () => {
    const controller = new AbortController();
    let fired = 0;

    const unlink = linkAbortSignal(controller.signal, () => fired++);
    unlink();
    controller.abort();

    expect(fired).toBe(0);
  });
});

describe("SandboxError", () => {
  test("formats the message alone when there are no details", () => {
    const error = new SandboxError("boom");
    expect(error.name).toBe("SandboxError");
    expect(error.details).toEqual([]);
    expect(error.formatForCli()).toEqual(["boom"]);
  });

  test("formats each detail as its own line under the message", () => {
    expect(new SandboxError("boom", ["first", "second"]).formatForCli()).toEqual([
      "boom",
      "first",
      "second",
    ]);
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

describe("execWriteFile staging cleanup", () => {
  test("reports the write failure even when the cleanup command itself fails", async () => {
    const commands: string[] = [];
    const executor = {
      async exec(command: string) {
        commands.push(command);
        // The cleanup channel is gone too — its rejection must stay swallowed
        // so the caller sees why the write failed, not why the cleanup did.
        if (command.startsWith("rm -f ")) throw new Error("cleanup channel is gone");
        if (command.startsWith("printf ")) return { stdout: "", stderr: "disk full", code: 1 };
        return { stdout: "", stderr: "", code: 0 };
      },
    };

    await expect(
      execWriteFile(executor, "/tmp/mikan-staging-probe.txt", "content"),
    ).rejects.toThrow("disk full");
    expect(commands.some((command) => command.startsWith("rm -f "))).toBe(true);
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
