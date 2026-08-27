import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { atomicWritePrivateFile } from "../utils/file-guards.js";

describe("atomicWritePrivateFile", () => {
  let dir: string;
  let targetPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-test-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    targetPath = join(dir, "test.txt");
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("writes content to file", () => {
    atomicWritePrivateFile(targetPath, "hello world");
    expect(readFileSync(targetPath, "utf-8")).toBe("hello world");
  });

  test("overwrites existing file atomically", () => {
    atomicWritePrivateFile(targetPath, "first");
    atomicWritePrivateFile(targetPath, "second");
    expect(readFileSync(targetPath, "utf-8")).toBe("second");
  });

  test("writes empty content", () => {
    atomicWritePrivateFile(targetPath, "");
    expect(readFileSync(targetPath, "utf-8")).toBe("");
  });

  test("writes multi-byte UTF-8 content", () => {
    atomicWritePrivateFile(targetPath, "你好世界 🌍");
    expect(readFileSync(targetPath, "utf-8")).toBe("你好世界 🌍");
  });

  test("new files are private (0600)", () => {
    atomicWritePrivateFile(targetPath, "secret");
    expect(statSync(targetPath).mode & 0o777).toBe(0o600);
  });

  test("overwriting a world-readable file leaves a private one", () => {
    writeFileSync(targetPath, "public");
    chmodSync(targetPath, 0o644);
    atomicWritePrivateFile(targetPath, "secret");
    expect(statSync(targetPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(targetPath, "utf-8")).toBe("secret");
  });

  test("leaves no temp files behind after a successful write", () => {
    atomicWritePrivateFile(targetPath, "content");
    expect(readdirSync(dir)).toEqual(["test.txt"]);
  });

  test("throws when the parent directory does not exist and keeps the old file intact", () => {
    atomicWritePrivateFile(targetPath, "original");
    expect(() => atomicWritePrivateFile(join(dir, "missing", "child.txt"), "x")).toThrow();
    expect(readFileSync(targetPath, "utf-8")).toBe("original");
  });
});
