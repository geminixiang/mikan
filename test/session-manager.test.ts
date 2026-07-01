import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as log from "../src/log.js";
import { SessionManager } from "../src/harness/session-manager.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-session-manager-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sessionFilePath(): string {
  return join(dir, "session.jsonl");
}

describe("SessionManager header recovery", () => {
  test("starts a fresh session when the first line isn't valid JSON", () => {
    writeFileSync(sessionFilePath(), "not json at all\n");
    const warn = vi.spyOn(log, "logWarning").mockImplementation(() => {});

    const session = SessionManager.open(sessionFilePath());

    expect(session.getHeader()).not.toBeNull();
    expect(session.getEntries()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  test("starts a fresh session when the first line is valid JSON but not a session header", () => {
    writeFileSync(
      sessionFilePath(),
      `${JSON.stringify({ type: "message", id: "a1", parentId: null, timestamp: "now" })}\n`,
    );
    const warn = vi.spyOn(log, "logWarning").mockImplementation(() => {});

    const session = SessionManager.open(sessionFilePath());

    expect(session.getHeader()?.id).toBeTruthy();
    expect(session.getEntries()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  test("starts a fresh session when the header version is unsupported", () => {
    writeFileSync(
      sessionFilePath(),
      `${JSON.stringify({ type: "session", version: 2, id: "old", timestamp: "now", cwd: "/tmp" })}\n`,
    );
    const warn = vi.spyOn(log, "logWarning").mockImplementation(() => {});

    const session = SessionManager.open(sessionFilePath());

    expect(session.getHeader()?.id).not.toBe("old");
    expect(warn).toHaveBeenCalled();
  });

  test("loads a valid v3 session file without starting fresh", () => {
    const header = { type: "session", version: 3, id: "keep-me", timestamp: "now", cwd: "/tmp" };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "now",
      message: { role: "user", content: "hi", timestamp: 0 },
    };
    writeFileSync(sessionFilePath(), `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
    const warn = vi.spyOn(log, "logWarning").mockImplementation(() => {});

    const session = SessionManager.open(sessionFilePath());

    expect(session.getHeader()?.id).toBe("keep-me");
    expect(session.getEntries()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test("appendCompaction persists a replayable compaction entry", () => {
    const session = SessionManager.create(dir, dir);
    session.appendMessage({ role: "user", content: "first", timestamp: 0 });
    const secondId = session.appendMessage({ role: "user", content: "second", timestamp: 1 });
    session.appendMessage({ role: "user", content: "third", timestamp: 2 });

    session.appendCompaction("summary of earlier turns", secondId, 12345);

    expect(session.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
    const context = session.buildSessionContext();
    const summaryMessage = context.messages.find(
      (m): m is Extract<typeof m, { role: "compactionSummary" }> => m.role === "compactionSummary",
    );
    expect(summaryMessage?.summary).toBe("summary of earlier turns");
    // "first" was summarized away; "second" (the compaction boundary) and "third" survive.
    expect(context.messages.some((m) => m.role === "user" && m.content === "first")).toBe(false);
    expect(context.messages.some((m) => m.role === "user" && m.content === "third")).toBe(true);
  });
});
