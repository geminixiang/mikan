import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { atomicWritePrivateFile } from "../src/utils/fs-atomic.js";

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
});
