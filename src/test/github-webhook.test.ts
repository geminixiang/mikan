import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, test, vi, afterEach } from "vitest";
import {
  GITHUB_WEBHOOK_PATH,
  handleGithubWebhookRequest,
  verifyWebhookSignature,
} from "../adapters/github/webhook.js";
import { GithubMessagingBot } from "../adapters/github/bot.js";
import type { GithubClient } from "../adapters/github/client.js";
import type { MessagingEventHandler } from "../adapter.js";
import type { Workspace } from "../office/types.js";

const SECRET = "hush";

function sign(body: string | Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

interface FakeResponse {
  res: ServerResponse;
  status: () => number | undefined;
  ended: () => boolean;
}

function makeRes(): FakeResponse {
  let status: number | undefined;
  let ended = false;
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end() {
      ended = true;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, ended: () => ended };
}

function makeReq(options: {
  method?: string;
  body?: string | Buffer;
  signature?: string;
  event?: string;
}): { req: IncomingMessage; url: URL } {
  const body = options.body ?? "{}";
  const req = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  req.method = options.method ?? "POST";
  req.headers = {};
  if (options.signature) req.headers["x-hub-signature-256"] = options.signature;
  if (options.event) req.headers["x-github-event"] = options.event;
  return { req, url: new URL(`http://localhost${GITHUB_WEBHOOK_PATH}`) };
}

describe("verifyWebhookSignature", () => {
  test("accepts a valid signature", () => {
    const body = Buffer.from('{"zen":"ok"}');
    expect(verifyWebhookSignature(SECRET, body, sign(body))).toBe(true);
  });

  test("rejects a wrong secret", () => {
    const body = Buffer.from("{}");
    expect(verifyWebhookSignature(SECRET, body, sign(body, "other"))).toBe(false);
  });

  test("rejects missing, unprefixed, and length-mismatched signatures", () => {
    const body = Buffer.from("{}");
    expect(verifyWebhookSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, "deadbeef")).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, "sha256=abc")).toBe(false);
  });
});

describe("handleGithubWebhookRequest", () => {
  const options = () => ({ secret: SECRET, onPoke: vi.fn() });

  test("ignores other paths", async () => {
    const { req } = makeReq({});
    const out = makeRes();
    const handled = await handleGithubWebhookRequest(
      req,
      out.res,
      new URL("http://localhost/health"),
      options(),
    );
    expect(handled).toBe(false);
    expect(out.ended()).toBe(false);
  });

  test("rejects non-POST with 405", async () => {
    const { req, url } = makeReq({ method: "GET" });
    const out = makeRes();
    expect(await handleGithubWebhookRequest(req, out.res, url, options())).toBe(true);
    expect(out.status()).toBe(405);
  });

  test("rejects a bad signature with 401 and does not poke", async () => {
    const opts = options();
    const { req, url } = makeReq({
      body: "{}",
      signature: sign("{}", "wrong"),
      event: "issue_comment",
    });
    const out = makeRes();
    expect(await handleGithubWebhookRequest(req, out.res, url, opts)).toBe(true);
    expect(out.status()).toBe(401);
    expect(opts.onPoke).not.toHaveBeenCalled();
  });

  test("rejects oversized bodies with 413", async () => {
    const opts = options();
    const big = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const { req, url } = makeReq({ body: big, signature: sign(big), event: "issue_comment" });
    const out = makeRes();
    expect(await handleGithubWebhookRequest(req, out.res, url, opts)).toBe(true);
    expect(out.status()).toBe(413);
    expect(opts.onPoke).not.toHaveBeenCalled();
  });

  test("answers ping with 200 without poking", async () => {
    const opts = options();
    const { req, url } = makeReq({ body: "{}", signature: sign("{}"), event: "ping" });
    const out = makeRes();
    expect(await handleGithubWebhookRequest(req, out.res, url, opts)).toBe(true);
    expect(out.status()).toBe(200);
    expect(opts.onPoke).not.toHaveBeenCalled();
  });

  test("pokes on relevant events with 202", async () => {
    for (const event of ["issues", "issue_comment", "pull_request_review_comment"]) {
      const opts = options();
      const { req, url } = makeReq({ body: "{}", signature: sign("{}"), event });
      const out = makeRes();
      expect(await handleGithubWebhookRequest(req, out.res, url, opts)).toBe(true);
      expect(out.status()).toBe(202);
      expect(opts.onPoke).toHaveBeenCalledTimes(1);
    }
  });

  test("accepts but ignores irrelevant events", async () => {
    const opts = options();
    const { req, url } = makeReq({ body: "{}", signature: sign("{}"), event: "push" });
    const out = makeRes();
    expect(await handleGithubWebhookRequest(req, out.res, url, opts)).toBe(true);
    expect(out.status()).toBe(202);
    expect(opts.onPoke).not.toHaveBeenCalled();
  });
});

function makeBot(): GithubMessagingBot {
  const handler = { handleEvent: vi.fn() } as unknown as MessagingEventHandler;
  const client = {} as GithubClient;
  const bot = new GithubMessagingBot(
    handler,
    {
      appId: "1",
      privateKey: "k",
      installationId: "2",
      repos: [],
      pollIntervalMs: 60_000,
      workspace: { root: "/nonexistent" } as unknown as Workspace,
      syncStatePath: "/nonexistent/github-sync.json",
    },
    client,
  );
  (bot as unknown as { stopped: boolean }).stopped = false;
  return bot;
}

describe("requestPoll", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("debounces a burst of pokes into one poll", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    const pollSpy = vi.spyOn(bot, "poll").mockResolvedValue(undefined);
    bot.requestPoll();
    bot.requestPoll();
    bot.requestPoll();
    expect(pollSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(pollSpy).toHaveBeenCalledTimes(1);
  });

  test("a poke landing mid-poll schedules a re-run after it finishes", async () => {
    vi.useFakeTimers();
    const bot = makeBot();
    let resolveFirst!: () => void;
    // Real poll(): sets pollInFlight, then re-runs via requestPoll when a poke
    // arrived mid-flight. Stub only the repo scan.
    const pollRepoGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let scans = 0;
    vi.spyOn(
      bot as unknown as { pollRepo: (repo: unknown) => Promise<boolean> },
      "pollRepo",
    ).mockImplementation(async () => {
      scans += 1;
      if (scans === 1) await pollRepoGate;
      return false;
    });
    (bot as unknown as { watchedRepos: unknown[] }).watchedRepos = [
      { owner: "octo", repo: "widgets" },
    ];

    const first = bot.poll();
    bot.requestPoll();
    expect(scans).toBe(1);
    resolveFirst();
    await first;
    await vi.advanceTimersByTimeAsync(2000);
    expect(scans).toBe(2);
  });
});
