import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as log from "../log.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import { appendBotResponseLog, appendOfficeLog, readOfficeLog } from "../office/log.js";
import type { Office } from "../office/types.js";

let root: string;
let office: Office;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mikan-office-log-"));
  office = createWorkspace({ root: join(root, "workspace"), stateDir: join(root, "state") }).office(
    createOfficeAddress("slack", "C1"),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("office log", () => {
  test("reads back what was appended, in order", () => {
    appendOfficeLog(office, { ts: "1.0", user: "U1", text: "hi", isMessagingBot: false });
    appendBotResponseLog(office, {
      text: "hello",
      ts: "2.0",
      threadTs: "1.0",
      answer: { replyTo: "1.0", sessionKey: "C1:1.0" },
    });

    expect(readOfficeLog(office)).toEqual([
      { ts: "1.0", user: "U1", text: "hi", isMessagingBot: false },
      {
        date: expect.any(String),
        ts: "2.0",
        threadTs: "1.0",
        user: "bot",
        text: "hello",
        attachments: [],
        isMessagingBot: true,
        replyTo: "1.0",
        sessionKey: "C1:1.0",
      },
    ]);
  });

  test("a bot response records Slack blocks only when given", () => {
    appendBotResponseLog(office, { text: "a", ts: "1.0" });
    appendBotResponseLog(office, { text: "b", ts: "2.0", platform: "slack", slackBlocks: [{}] });

    const [plain, slack] = readOfficeLog(office);
    expect(plain).not.toHaveProperty("platform");
    expect(plain).not.toHaveProperty("slackBlocks");
    expect(slack).toMatchObject({ platform: "slack", slackBlocks: [{}] });
  });

  test("skips malformed lines with a warning and keeps the rest", () => {
    const warn = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    appendOfficeLog(office, { ts: "1.0", text: "before" });
    appendFileSync(office.logPath, "not json\n[1]\n");
    appendOfficeLog(office, { ts: "2.0", text: "after" });

    expect(readOfficeLog(office).map((entry) => entry.text)).toEqual(["before", "after"]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  test("a missing log reads as empty", () => {
    expect(readOfficeLog(office)).toEqual([]);
  });
});
