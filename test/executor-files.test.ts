import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HostExecutor } from "../src/sandbox/host.js";
import { execReadFile, execWriteFile } from "../src/sandbox/utils.js";
import { createEditTool } from "../src/tools/edit.js";

/**
 * Contract test for the Executor file transport: the same matrix runs against
 * the host executor's native fs implementation and against the shared
 * exec-backed implementation (base64 over a real `sh`), which is what the
 * container/cloudflare executors delegate to. Content that would
 * corrupt under shell parsing is the point of the matrix.
 */

const host = new HostExecutor();

/** The exec-backed transport, using the host shell as the exec channel. */
const execBacked = {
  readFile: (path: string) => execReadFile(host, path),
  writeFile: (path: string, content: string) => execWriteFile(host, path, content),
};

const native = {
  readFile: (path: string) => host.readFile(path),
  writeFile: (path: string, content: string) => host.writeFile(path, content),
};

const NASTY_CONTENTS: Array<[string, string]> = [
  ["single quotes", "it's got 'quotes' everywhere '' '"],
  ["double quotes and dollars", 'echo "$HOME" `whoami` $(reboot)'],
  ["backslashes", "C:\\path\\to\\file \\n not a newline \\\\"],
  ["newlines and tabs", "line1\n\tline2\r\nline3\n"],
  ["unicode", "橘子 🍊 émojis ñ"],
  ["percent signs", "100% %s %d %%"],
  ["empty", ""],
  ["trailing newline preserved", "ends with newline\n"],
  ["no trailing newline", "no newline at end"],
];

describe.each([
  ["native fs (host executor)", native],
  ["exec-backed base64 (container/ssh/http executors)", execBacked],
])("file transport: %s", (_name, transport) => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-exec-files-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test.each(NASTY_CONTENTS)("round-trips %s exactly", async (_label, content) => {
    const path = join(dir, "file.txt");
    await transport.writeFile(path, content);
    expect(readFileSync(path, "utf-8")).toBe(content);
    expect(await transport.readFile(path)).toBe(content);
  });

  test("creates parent directories", async () => {
    const path = join(dir, "a", "b", "c", "file.txt");
    await transport.writeFile(path, "nested");
    expect(await transport.readFile(path)).toBe("nested");
  });

  test("round-trips content larger than one write chunk", async () => {
    // > 2 base64 chunks (65536 chars each): ~150KB of raw content.
    const content = "x".repeat(120_000) + "\n" + "y'\"$`".repeat(8_000);
    const path = join(dir, "large.txt");
    await transport.writeFile(path, content);
    expect(await transport.readFile(path)).toBe(content);
  });

  test("leaves no staging files behind", async () => {
    const path = join(dir, "file.txt");
    await transport.writeFile(path, "content");
    expect(readdirSync(dir)).toEqual(["file.txt"]);
  });

  test("read of a missing file rejects", async () => {
    await expect(transport.readFile(join(dir, "missing.txt"))).rejects.toThrow();
  });
});

describe("edit tool through the executor file transport", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-edit-transport-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("edits survive shell-hostile content", async () => {
    const path = join(dir, "config.sh");
    const original = `PASSWORD='it\\'s $ecret'\necho "done" # 100%\n`;
    writeFileSync(path, original);

    const tool = createEditTool(host);
    await tool.execute("1", {
      label: "rotate password",
      path,
      oldText: "$ecret",
      newText: 'n3w-"$ecret"-`v2`',
    });

    expect(readFileSync(path, "utf-8")).toBe(
      `PASSWORD='it\\'s n3w-"$ecret"-\`v2\`'\necho "done" # 100%\n`,
    );
  });

  test("missing file yields a readable error", async () => {
    const tool = createEditTool(host);
    await expect(
      tool.execute("1", {
        label: "edit",
        path: join(dir, "nope.txt"),
        oldText: "a",
        newText: "b",
      }),
    ).rejects.toThrow();
  });
});
