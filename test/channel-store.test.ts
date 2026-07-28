import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createOfficeAddress, officeDirName } from "../src/office-address.js";
import { ChannelStore } from "../src/store.js";

const office = (channelId: string) => officeDirName(createOfficeAddress("slack", channelId));

function okResponse(body: string): Response {
  return new Response(Buffer.from(body), { status: 200 });
}

function jsonLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("ChannelStore", () => {
  let dir: string;
  let store: ChannelStore;

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-store-test-${Date.now()}-${Math.random()}`);
    store = new ChannelStore({ workingDir: dir, botToken: "xoxb-test-token" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  test("constructor creates the working directory", () => {
    expect(existsSync(dir)).toBe(true);
  });

  test("getChannelDir creates and returns the channel directory", () => {
    const channelDir = store.getChannelDir("C123");
    expect(channelDir).toBe(join(dir, office("C123")));
    expect(existsSync(channelDir)).toBe(true);
  });

  describe("generateLocalFilename", () => {
    test("prefixes the millisecond timestamp and sanitizes the name", () => {
      expect(store.generateLocalFilename("my file (1).png", "1234567890.123456")).toBe(
        "1234567890123_my_file__1_.png",
      );
    });

    test("keeps safe characters intact", () => {
      expect(store.generateLocalFilename("report-v2_final.txt", "1000.5")).toBe(
        "1000500_report-v2_final.txt",
      );
    });
  });

  describe("logMessage", () => {
    test("appends a JSONL line and returns true", async () => {
      const logged = await store.logMessage("C1", {
        date: "2026-01-01T00:00:00.000Z",
        ts: "1.0",
        user: "U1",
        text: "hello",
        attachments: [],
        isMessagingBot: false,
      });
      expect(logged).toBe(true);
      const lines = jsonLines(join(dir, office("C1"), "log.jsonl"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ user: "U1", text: "hello", ts: "1.0" });
    });

    test("returns false for a duplicate channel+ts", async () => {
      const message = {
        date: "2026-01-01T00:00:00.000Z",
        ts: "42.0",
        user: "U1",
        text: "once",
        attachments: [],
        isMessagingBot: false,
      };
      expect(await store.logMessage("C1", message)).toBe(true);
      expect(await store.logMessage("C1", { ...message, text: "twice" })).toBe(false);
      expect(jsonLines(join(dir, office("C1"), "log.jsonl"))).toHaveLength(1);
    });

    test("suppresses concurrent duplicate logging", async () => {
      const message = {
        date: "2026-01-01T00:00:00.000Z",
        ts: "7.0",
        user: "U1",
        text: "racy",
        attachments: [],
        isMessagingBot: false,
      };
      const results = await Promise.all([
        store.logMessage("C1", message),
        store.logMessage("C1", { ...message }),
      ]);
      expect(results.filter((r) => r).length).toBe(1);
      expect(jsonLines(join(dir, office("C1"), "log.jsonl"))).toHaveLength(1);
    });

    test("same ts in different channels is not a duplicate", async () => {
      const message = {
        date: "2026-01-01T00:00:00.000Z",
        ts: "9.0",
        user: "U1",
        text: "hi",
        attachments: [],
        isMessagingBot: false,
      };
      expect(await store.logMessage("C1", message)).toBe(true);
      expect(await store.logMessage("C2", { ...message })).toBe(true);
    });

    test("derives date from a Slack-style fractional timestamp", async () => {
      await store.logMessage("C1", {
        date: "",
        ts: "1234567890.123456",
        user: "U1",
        text: "x",
        attachments: [],
        isMessagingBot: false,
      });
      const [line] = jsonLines(join(dir, office("C1"), "log.jsonl"));
      expect(line.date).toBe("2009-02-13T23:31:30.123Z");
    });

    test("derives date from an epoch-milliseconds timestamp", async () => {
      await store.logMessage("C1", {
        date: "",
        ts: "1700000000000",
        user: "U1",
        text: "x",
        attachments: [],
        isMessagingBot: false,
      });
      const [line] = jsonLines(join(dir, office("C1"), "log.jsonl"));
      expect(line.date).toBe("2023-11-14T22:13:20.000Z");
    });

    test("a failed append does not poison the dedupe cache", async () => {
      const message = {
        date: "2026-01-01T00:00:00.000Z",
        ts: "5.0",
        user: "U1",
        text: "retry me",
        attachments: [],
        isMessagingBot: false,
      };
      // Make the append fail by occupying log.jsonl with a directory
      mkdirSync(join(dir, office("C1"), "log.jsonl"), { recursive: true });
      await expect(store.logMessage("C1", message)).rejects.toThrow();

      rmdirSync(join(dir, office("C1"), "log.jsonl"));
      expect(await store.logMessage("C1", message)).toBe(true);
      expect(jsonLines(join(dir, office("C1"), "log.jsonl"))).toHaveLength(1);
    });
  });

  test("logBotResponse writes a bot-attributed entry", async () => {
    await store.logBotResponse("C1", "response text", "99.0");
    const [line] = jsonLines(join(dir, office("C1"), "log.jsonl"));
    expect(line).toMatchObject({
      user: "bot",
      text: "response text",
      ts: "99.0",
      isMessagingBot: true,
    });
  });

  describe("getLastTimestamp", () => {
    test("returns null when no log exists", () => {
      expect(store.getLastTimestamp("C-missing")).toBeNull();
    });

    test("returns the ts of the last line", async () => {
      for (const ts of ["1.0", "2.0", "3.0"]) {
        await store.logMessage("C1", {
          date: "2026-01-01T00:00:00.000Z",
          ts,
          user: "U1",
          text: ts,
          attachments: [],
          isMessagingBot: false,
        });
      }
      expect(store.getLastTimestamp("C1")).toBe("3.0");
    });

    test("returns null for an empty log file", () => {
      mkdirSync(join(dir, office("C1")), { recursive: true });
      writeFileSync(join(dir, office("C1"), "log.jsonl"), "");
      expect(store.getLastTimestamp("C1")).toBeNull();
    });

    test("returns null when the last line is malformed", () => {
      mkdirSync(join(dir, office("C1")), { recursive: true });
      writeFileSync(join(dir, office("C1"), "log.jsonl"), "not json\n");
      expect(store.getLastTimestamp("C1")).toBeNull();
    });

    test("returns null when the last entry has no ts", () => {
      mkdirSync(join(dir, office("C1")), { recursive: true });
      writeFileSync(join(dir, office("C1"), "log.jsonl"), `${JSON.stringify({ text: "no ts" })}\n`);
      expect(store.getLastTimestamp("C1")).toBeNull();
    });
  });

  describe("processAttachments", () => {
    test("downloads attachments with the bot token and returns local paths", async () => {
      const fetchMock = vi.fn().mockResolvedValue(okResponse("file body"));
      vi.stubGlobal("fetch", fetchMock);

      const attachments = await store.processAttachments(
        "C1",
        [{ name: "report.pdf", url_private_download: "https://files.example/report" }],
        "1.5",
      );

      expect(attachments).toEqual([
        { original: "report.pdf", localPath: `${office("C1")}/attachments/1500_report.pdf` },
      ]);
      expect(readFileSync(join(dir, office("C1"), "attachments", "1500_report.pdf"), "utf-8")).toBe(
        "file body",
      );
      expect(fetchMock).toHaveBeenCalledWith("https://files.example/report", {
        headers: { Authorization: "Bearer xoxb-test-token" },
      });
    });

    test("falls back to url_private and skips files without any URL", async () => {
      const fetchMock = vi.fn().mockResolvedValue(okResponse("x"));
      vi.stubGlobal("fetch", fetchMock);

      const attachments = await store.processAttachments(
        "C1",
        [{ name: "a.txt", url_private: "https://files.example/a" }, { name: "no-url.txt" }],
        "2.0",
      );

      expect(attachments).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("https://files.example/a", expect.anything());
    });

    test("rejects when an attachment has a URL but no name", async () => {
      vi.stubGlobal("fetch", vi.fn());
      await expect(
        store.processAttachments("C1", [{ url_private: "https://files.example/x" }], "3.0"),
      ).rejects.toThrow(/missing name/);
    });

    test("does not retry non-retryable HTTP errors", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("nope", { status: 404, statusText: "Not Found" }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        store.processAttachments(
          "C1",
          [{ name: "gone.txt", url_private_download: "https://files.example/gone" }],
          "4.0",
        ),
      ).rejects.toThrow(/Failed to download attachment .*HTTP 404/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test("retries server errors up to three attempts", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response("boom", { status: 500, statusText: "Server Error" }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        store.processAttachments(
          "C1",
          [{ name: "flaky.txt", url_private_download: "https://files.example/flaky" }],
          "5.0",
        ),
      ).rejects.toThrow(/HTTP 500/);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }, 10_000);

    test("retries network errors and succeeds on a later attempt", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValue(okResponse("recovered"));
      vi.stubGlobal("fetch", fetchMock);

      const attachments = await store.processAttachments(
        "C1",
        [{ name: "net.txt", url_private_download: "https://files.example/net" }],
        "6.0",
      );

      expect(attachments).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(readFileSync(join(dir, office("C1"), "attachments", "6000_net.txt"), "utf-8")).toBe(
        "recovered",
      );
    }, 10_000);
  });
});
