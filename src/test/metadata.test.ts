import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isPlatformHistorySession } from "../sessions/store.js";

describe("isPlatformHistorySession", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-test-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("returns false for missing session file", () => {
    expect(isPlatformHistorySession(join(dir, "nonexistent.jsonl"))).toBe(false);
  });

  test("returns false for non-platform-history session", () => {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "abc",
        timestamp: "2024-01-01",
        cwd: "/tmp",
      }) + "\n",
      "utf-8",
    );
    expect(isPlatformHistorySession(sessionFile)).toBe(false);
  });

  test("returns true for platform-history session", () => {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "abc",
        timestamp: "2024-01-01",
        cwd: "/tmp",
        source: { kind: "platform-history" },
      }) + "\n",
      "utf-8",
    );
    expect(isPlatformHistorySession(sessionFile)).toBe(true);
  });

  test("returns false for malformed session file", () => {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(sessionFile, "not json", "utf-8");
    expect(isPlatformHistorySession(sessionFile)).toBe(false);
  });

  test("returns false when SessionManager.open throws", () => {
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "session",
        version: 3,
        id: "abc",
        timestamp: "2024-01-01",
        cwd: "/tmp",
      }) + "\n",
      "utf-8",
    );
    chmodSync(sessionFile, 0o000);
    try {
      expect(isPlatformHistorySession(sessionFile)).toBe(false);
    } finally {
      chmodSync(sessionFile, 0o644);
    }
  });
});
