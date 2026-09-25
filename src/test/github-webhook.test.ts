import { createHmac } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  GITHUB_WEBHOOK_PATH,
  handleGithubWebhookRequest,
  verifyWebhookSignature,
} from "../adapters/github/webhook.js";
import { GithubMessagingBot } from "../adapters/github/bot.js";
import type { GithubApi } from "../adapters/github/types.js";
import { createWorkspace } from "../office/index.js";
import type { MessagingEventHandler } from "../types.js";

const SECRET = "hush";

function sign(body: string | Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

interface FakeResponse {
  res: ServerResponse;
  status: () => number | undefined;
  ended: () => boolean;
}

function makeRes(req: IncomingMessage): FakeResponse {
  const res = new ServerResponse(req);
  return {
    res,
    status: () => (res.headersSent ? res.statusCode : undefined),
    ended: () => res.writableEnded,
  };
}

function makeReq(options: {
  method?: string;
  body?: string | Buffer;
  signature?: string;
  event?: string;
}): { req: IncomingMessage; url: URL } {
  const req = new IncomingMessage(new Socket());
  req.method = options.method ?? "POST";
  if (options.signature) req.headers["x-hub-signature-256"] = options.signature;
  if (options.event) req.headers["x-github-event"] = options.event;
  req.push(Buffer.from(options.body ?? "{}"));
  req.push(null);
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
    const out = makeRes(req);
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
    const out = makeRes(req);
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
    const out = makeRes(req);
    expect(await handleGithubWebhookRequest(req, out.res, url, opts)).toBe(true);
    expect(out.status()).toBe(401);
    expect(opts.onPoke).not.toHaveBeenCalled();
  });

  test("rejects oversized bodies with 413", async () => {
    const opts = options();
    const big = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const { req, url } = makeReq({ body: big, signature: sign(big), event: "issue_comment" });
    const out = makeRes(req);
    expect(await handleGithubWebhookRequest(req, out.res, url, opts)).toBe(true);
    expect(out.status()).toBe(413);
    expect(opts.onPoke).not.toHaveBeenCalled();
  });

  test("answers ping with 200 without poking", async () => {
    const opts = options();
    const { req, url } = makeReq({ body: "{}", signature: sign("{}"), event: "ping" });
    const out = makeRes(req);
    expect(await handleGithubWebhookRequest(req, out.res, url, opts)).toBe(true);
    expect(out.status()).toBe(200);
    expect(opts.onPoke).not.toHaveBeenCalled();
  });

  test("pokes on relevant events with 202", async () => {
    for (const event of ["issues", "issue_comment", "pull_request_review_comment"]) {
      const opts = options();
      const { req, url } = makeReq({ body: "{}", signature: sign("{}"), event });
      const out = makeRes(req);
      expect(await handleGithubWebhookRequest(req, out.res, url, opts)).toBe(true);
      expect(out.status()).toBe(202);
      expect(opts.onPoke).toHaveBeenCalledTimes(1);
    }
  });

  test("accepts but ignores irrelevant events", async () => {
    const opts = options();
    const { req, url } = makeReq({ body: "{}", signature: sign("{}"), event: "push" });
    const out = makeRes(req);
    expect(await handleGithubWebhookRequest(req, out.res, url, opts)).toBe(true);
    expect(out.status()).toBe(202);
    expect(opts.onPoke).not.toHaveBeenCalled();
  });
});

function makeHandler(): MessagingEventHandler {
  return {
    isRunning: vi.fn<MessagingEventHandler["isRunning"]>().mockReturnValue(false),
    getRunningSessions: vi.fn<MessagingEventHandler["getRunningSessions"]>().mockReturnValue([]),
    handleEvent: vi.fn<MessagingEventHandler["handleEvent"]>(),
    handleStop: vi.fn<MessagingEventHandler["handleStop"]>(),
    forceStop: vi.fn<MessagingEventHandler["forceStop"]>(),
    handleNewCommand: vi.fn<MessagingEventHandler["handleNewCommand"]>(),
  };
}

function makeClient(): GithubApi {
  return {
    getAppSlug: vi.fn<GithubApi["getAppSlug"]>().mockResolvedValue("mikan"),
    getUserId: vi.fn<GithubApi["getUserId"]>().mockResolvedValue(999),
    createScopedInstallationToken: vi.fn<GithubApi["createScopedInstallationToken"]>(),
    getRepository: vi.fn<GithubApi["getRepository"]>(),
    getCollaboratorPermission: vi.fn<GithubApi["getCollaboratorPermission"]>(),
    createPullRequest: vi.fn<GithubApi["createPullRequest"]>(),
    getPullRequest: vi.fn<GithubApi["getPullRequest"]>(),
    listPullRequestFiles: vi.fn<GithubApi["listPullRequestFiles"]>(),
    listPullRequestReviews: vi.fn<GithubApi["listPullRequestReviews"]>(),
    listIssueComments: vi.fn<GithubApi["listIssueComments"]>(),
    listIssues: vi.fn<GithubApi["listIssues"]>(),
    findOpenPullRequestByBranch: vi.fn<GithubApi["findOpenPullRequestByBranch"]>(),
    listCheckRuns: vi.fn<GithubApi["listCheckRuns"]>(),
    getJobLog: vi.fn<GithubApi["getJobLog"]>(),
    listInstallationRepositories: vi.fn<GithubApi["listInstallationRepositories"]>(),
    listIssueCommentsSince: vi.fn<GithubApi["listIssueCommentsSince"]>().mockResolvedValue([]),
    listPullReviewCommentsSince: vi
      .fn<GithubApi["listPullReviewCommentsSince"]>()
      .mockResolvedValue([]),
    listPullReviewComments: vi.fn<GithubApi["listPullReviewComments"]>(),
    listIssuesSince: vi.fn<GithubApi["listIssuesSince"]>().mockResolvedValue([]),
    getIssue: vi.fn<GithubApi["getIssue"]>(),
    addIssueLabels: vi.fn<GithubApi["addIssueLabels"]>(),
    removeIssueLabel: vi.fn<GithubApi["removeIssueLabel"]>(),
    addIssueAssignees: vi.fn<GithubApi["addIssueAssignees"]>(),
    removeIssueAssignees: vi.fn<GithubApi["removeIssueAssignees"]>(),
    updateIssueState: vi.fn<GithubApi["updateIssueState"]>(),
    createIssueComment: vi.fn<GithubApi["createIssueComment"]>(),
    updateIssueComment: vi.fn<GithubApi["updateIssueComment"]>(),
    deleteIssueComment: vi.fn<GithubApi["deleteIssueComment"]>(),
    createCommentReaction: vi.fn<GithubApi["createCommentReaction"]>(),
    replyToReviewComment: vi.fn<GithubApi["replyToReviewComment"]>(),
    createReviewCommentReaction: vi.fn<GithubApi["createReviewCommentReaction"]>(),
    createIssueReaction: vi.fn<GithubApi["createIssueReaction"]>(),
  };
}

async function startBot(stateDir: string, client: GithubApi): Promise<GithubMessagingBot> {
  const bot = new GithubMessagingBot(
    makeHandler(),
    {
      appId: "1",
      privateKey: "k",
      installationId: "2",
      repos: ["octo/widgets"],
      pollIntervalMs: 60_000,
      workspace: createWorkspace({ root: join(stateDir, "workspace"), stateDir }),
      syncStatePath: join(stateDir, "github-sync.json"),
    },
    client,
  );
  await bot.start();
  return bot;
}

describe("requestPoll", () => {
  let stateDir: string;
  let bot: GithubMessagingBot | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mikan-github-webhook-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await bot?.stop();
    bot = undefined;
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("debounces a burst of pokes into one poll", async () => {
    vi.useFakeTimers();
    bot = await startBot(stateDir, makeClient());
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
    let resolveFirst!: () => void;
    const pollRepoGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let scans = 0;
    const client = makeClient();
    vi.mocked(client.listIssuesSince).mockImplementation(async () => {
      scans += 1;
      if (scans === 1) await pollRepoGate;
      return [];
    });
    const started = await startBot(stateDir, client);
    bot = started;

    const first = started.poll();
    started.requestPoll();
    expect(scans).toBe(1);
    resolveFirst();
    await first;
    await vi.advanceTimersByTimeAsync(2000);
    expect(scans).toBe(2);
  });
});
