import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MessagingEventHandler } from "../src/adapter.js";
import { GithubMessagingBot } from "../src/adapters/github/bot.js";
import type { GithubClient } from "../src/adapters/github/client.js";
import {
  buildGithubConversationId,
  GITHUB_ISSUE_BODY_TS,
  parseGithubConversationId,
} from "../src/adapters/github/ids.js";
import { cloneRepo, pushBranch } from "../src/adapters/github/repo.js";
import type { GithubIssue, GithubIssueComment } from "../src/adapters/github/types.js";

vi.mock("../src/adapters/github/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/github/repo.js")>();
  return {
    ...actual,
    cloneRepo: vi.fn().mockResolvedValue(undefined),
    pushBranch: vi.fn().mockResolvedValue(undefined),
  };
});

function makeHandler(runningKeys: string[] = []): MessagingEventHandler {
  const running = new Set(runningKeys);
  return {
    isRunning: vi.fn((key: string) => running.has(key)),
    getRunningSessions: vi
      .fn()
      .mockReturnValue([...running].map((sessionKey) => ({ sessionKey, startedAt: Date.now() }))),
    handleEvent: vi.fn(),
    handleStop: vi.fn(),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn(),
  };
}

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeComment(overrides: Partial<GithubIssueComment> = {}): GithubIssueComment {
  const createdAt = futureIso();
  return {
    id: 9001,
    body: "hello",
    user: { login: "alice", type: "User" },
    created_at: createdAt,
    updated_at: createdAt,
    issue_url: "https://api.github.com/repos/octo/widgets/issues/5",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<GithubIssue> = {}): GithubIssue {
  const createdAt = futureIso();
  return {
    id: 7001,
    number: 5,
    title: "Widget breaks",
    body: "It broke.",
    user: { login: "alice", type: "User" },
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  };
}

interface FakeClient {
  getAppSlug: ReturnType<typeof vi.fn>;
  getUserId: ReturnType<typeof vi.fn>;
  listInstallationRepositories: ReturnType<typeof vi.fn>;
  listIssuesSince: ReturnType<typeof vi.fn>;
  listIssueCommentsSince: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  createIssueComment: ReturnType<typeof vi.fn>;
  updateIssueComment: ReturnType<typeof vi.fn>;
  deleteIssueComment: ReturnType<typeof vi.fn>;
  createCommentReaction: ReturnType<typeof vi.fn>;
  createIssueReaction: ReturnType<typeof vi.fn>;
  createScopedInstallationToken: ReturnType<typeof vi.fn>;
  getRepository: ReturnType<typeof vi.fn>;
  createPullRequest: ReturnType<typeof vi.fn>;
  getCollaboratorPermission: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return {
    getAppSlug: vi.fn().mockResolvedValue("mikan"),
    getUserId: vi.fn().mockResolvedValue(999),
    listInstallationRepositories: vi.fn().mockResolvedValue([]),
    listIssuesSince: vi.fn().mockResolvedValue([]),
    listIssueCommentsSince: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue(makeIssue()),
    createIssueComment: vi.fn().mockResolvedValue(makeComment({ id: 555 })),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    deleteIssueComment: vi.fn().mockResolvedValue(undefined),
    createCommentReaction: vi.fn().mockResolvedValue(undefined),
    createIssueReaction: vi.fn().mockResolvedValue(undefined),
    createScopedInstallationToken: vi.fn().mockResolvedValue("scoped-token"),
    getRepository: vi.fn().mockResolvedValue({ default_branch: "main" }),
    getCollaboratorPermission: vi.fn().mockResolvedValue({ permission: "write" }),
    createPullRequest: vi
      .fn()
      .mockResolvedValue({ number: 7, html_url: "https://github.com/octo/widgets/pull/7" }),
  };
}

const CONVERSATION_ID = "GH_octo_widgets_5";

async function settleQueues(): Promise<void> {
  // MessagingEventQueue processes asynchronously; yield a few microtask turns.
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("GitHub conversation ids", () => {
  test("round-trips owner/repo/number", () => {
    const id = buildGithubConversationId({ owner: "octo", repo: "widgets", number: 42 });
    expect(id).toBe("GH_octo_widgets_42");
    expect(parseGithubConversationId(id)).toEqual({ owner: "octo", repo: "widgets", number: 42 });
  });

  test("round-trips repos containing underscores, dots, hyphens, and digits", () => {
    for (const repo of ["my.repo_x", "my_repo", "foo-2", "repo_45", "a_1_b_2"]) {
      const id = buildGithubConversationId({ owner: "my-org", repo, number: 42 });
      expect(parseGithubConversationId(id)).toEqual({ owner: "my-org", repo, number: 42 });
    }
  });

  test("lowercases owner/repo (GitHub names are case-insensitive)", () => {
    expect(buildGithubConversationId({ owner: "Octo", repo: "Widgets", number: 5 })).toBe(
      "GH_octo_widgets_5",
    );
    expect(parseGithubConversationId("GH_Octo_Widgets_5")).toEqual({
      owner: "octo",
      repo: "widgets",
      number: 5,
    });
  });

  test("rejects non-GitHub and malformed ids", () => {
    for (const bad of ["C03045VJJAY", "GH_octo_widgets", "GH_octo_widgets_x", "GH__widgets_1"]) {
      expect(() => parseGithubConversationId(bad)).toThrow(/Not a GitHub conversation id/);
    }
  });
});

describe("GithubMessagingBot", () => {
  let workingDir: string;
  let client: FakeClient;
  let handler: MessagingEventHandler;

  beforeEach(() => {
    workingDir = join(tmpdir(), `mikan-github-bot-${Date.now()}-${Math.random()}`);
    mkdirSync(workingDir, { recursive: true });
    client = makeFakeClient();
    handler = makeHandler();
    vi.mocked(cloneRepo).mockClear();
    vi.mocked(pushBranch).mockClear();
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  function makeBot(overrides: { handler?: MessagingEventHandler; repos?: string[] } = {}) {
    return new GithubMessagingBot(
      overrides.handler ?? handler,
      {
        appId: "1",
        privateKey: "unused",
        installationId: "2",
        repos: overrides.repos ?? ["octo/widgets"],
        pollIntervalMs: 60_000,
        workingDir,
        syncStatePath: join(workingDir, "state", "github-sync.json"),
      },
      client as unknown as GithubClient,
    );
  }

  test("start resolves watched repos from the installation when none configured", async () => {
    client.listInstallationRepositories.mockResolvedValue([
      { name: "widgets", owner: { login: "octo", type: "Organization" } },
    ]);
    const bot = makeBot({ repos: [] });
    await bot.start();
    await bot.poll();
    expect(client.listIssueCommentsSince).toHaveBeenCalledWith(
      "octo",
      "widgets",
      expect.any(String),
    );
  });

  test("start rejects malformed GITHUB_REPOS entries", async () => {
    const bot = makeBot({ repos: ["not-a-repo"] });
    await expect(bot.start()).rejects.toThrow(/Invalid GITHUB_REPOS entry/);
  });

  test("GITHUB_REPOS casing does not change conversation identity", async () => {
    const bot = makeBot({ repos: ["Octo/Widgets"] });
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "@mikan hi" })]);

    await bot.poll();
    await settleQueues();

    expect(client.listIssueCommentsSince).toHaveBeenCalledWith(
      "octo",
      "widgets",
      expect.any(String),
    );
    const [event] = vi.mocked(handler.handleEvent).mock.calls[0];
    expect(event.conversationId).toBe(CONVERSATION_ID);
  });

  test("mentioned comment triggers a run with the mention stripped", async () => {
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([
      makeComment({ body: "@mikan please fix this" }),
    ]);

    await bot.poll();
    await settleQueues();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    const [event] = vi.mocked(handler.handleEvent).mock.calls[0];
    expect(event.conversationId).toBe(CONVERSATION_ID);
    expect(event.sessionKey).toBe(CONVERSATION_ID);
    expect(event.conversationKind).toBe("shared");
    expect(event.ts).toBe("9001");
    expect(event.user).toBe("alice");
    expect(event.text).toBe("please fix this");
  });

  test("first contact via comment logs the issue body before the comment", async () => {
    // Issue created long ago: its log entry must still be dated just before
    // the triggering comment, or history sync's recency window drops it.
    client.getIssue.mockResolvedValue(
      makeIssue({ created_at: "2020-01-01T00:00:00Z", updated_at: "2020-01-01T00:00:00Z" }),
    );
    const bot = makeBot();
    await bot.start();
    const comment = makeComment({ body: "@mikan thoughts?" });
    client.listIssueCommentsSince.mockResolvedValue([comment]);

    await bot.poll();
    await settleQueues();

    const lines = readFileSync(join(workingDir, CONVERSATION_ID, "log.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0].ts).toBe(GITHUB_ISSUE_BODY_TS);
    expect(lines[0].text).toContain("# Widget breaks");
    expect(Date.parse(lines[0].date)).toBe(Date.parse(comment.created_at) - 1000);
    expect(lines[1].ts).toBe("9001");
    expect(lines[1].text).toBe("thoughts?");
  });

  test("unmentioned comment in an unknown issue is ignored without creating state", async () => {
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "unrelated chatter" })]);

    await bot.poll();
    await settleQueues();

    expect(handler.handleEvent).not.toHaveBeenCalled();
    expect(existsSync(join(workingDir, CONVERSATION_ID))).toBe(false);
  });

  test("unmentioned comment in a participating conversation triggers", async () => {
    mkdirSync(join(workingDir, CONVERSATION_ID, "repo"), { recursive: true });
    writeFileSync(join(workingDir, CONVERSATION_ID, "log.jsonl"), "{}\n");
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "follow-up question" })]);

    await bot.poll();
    await settleQueues();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(client.getIssue).not.toHaveBeenCalled();
  });

  test("bot comments and pre-baseline (edited) comments do not trigger", async () => {
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([
      makeComment({ id: 1, body: "@mikan hi", user: { login: "mikan[bot]", type: "Bot" } }),
      makeComment({
        id: 2,
        body: "@mikan hi",
        created_at: new Date(Date.now() - 60_000).toISOString(),
        updated_at: futureIso(),
      }),
    ]);

    await bot.poll();
    await settleQueues();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("a comment id seen once does not re-trigger on later polls", async () => {
    const bot = makeBot();
    await bot.start();
    const comment = makeComment({ body: "@mikan ping" });
    client.listIssueCommentsSince.mockResolvedValue([comment]);

    await bot.poll();
    await bot.poll();
    await settleQueues();
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
  });

  test("newly opened issue mentioning the bot triggers with title and body", async () => {
    const bot = makeBot();
    await bot.start();
    client.listIssuesSince.mockResolvedValue([makeIssue({ body: "@mikan can you triage this?" })]);

    await bot.poll();
    await settleQueues();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    const [event] = vi.mocked(handler.handleEvent).mock.calls[0];
    expect(event.ts).toBe(GITHUB_ISSUE_BODY_TS);
    expect(event.text).toContain("# Widget breaks");
    expect(event.text).toContain("can you triage this?");
    expect(event.text).not.toContain("@mikan");
  });

  test("issues merely updated by comment activity are not treated as new", async () => {
    const bot = makeBot();
    await bot.start();
    client.listIssuesSince.mockResolvedValue([
      makeIssue({
        body: "@mikan old issue",
        created_at: new Date(Date.now() - 60_000).toISOString(),
        updated_at: futureIso(),
      }),
    ]);

    await bot.poll();
    await settleQueues();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("mentioned 'stop' comment stops the running session instead of starting a run", async () => {
    const stopHandler = makeHandler([CONVERSATION_ID]);
    const bot = makeBot({ handler: stopHandler });
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "@mikan stop" })]);

    await bot.poll();
    await settleQueues();

    expect(stopHandler.handleStop).toHaveBeenCalledWith(CONVERSATION_ID, CONVERSATION_ID, bot);
    expect(stopHandler.handleEvent).not.toHaveBeenCalled();
  });

  test("start records the baseline watermark on disk", async () => {
    const bot = makeBot();
    await bot.start();
    const statePath = join(workingDir, "state", "github-sync.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.repos["octo/widgets"].baseline).toBeTruthy();
    expect(state.repos["octo/widgets"].seenComments).toEqual([]);
  });

  test("a comment handled before a restart does not re-trigger after it", async () => {
    const bot1 = makeBot();
    await bot1.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "@mikan ping" })]);
    await bot1.poll();
    await settleQueues();
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);

    const handler2 = makeHandler();
    const bot2 = makeBot({ handler: handler2 });
    await bot2.start();
    await bot2.poll();
    await settleQueues();
    expect(handler2.handleEvent).not.toHaveBeenCalled();
  });

  test("comments posted while mikan was down still trigger after restart", async () => {
    const statePath = join(workingDir, "state", "github-sync.json");
    mkdirSync(join(workingDir, "state"), { recursive: true });
    const baseline = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const cursor = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(
      statePath,
      JSON.stringify({
        repos: {
          "octo/widgets": { baseline, cursor, seenComments: [], seenIssues: [] },
        },
      }),
    );
    const downtime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    client.listIssueCommentsSince.mockResolvedValue([
      makeComment({
        body: "@mikan while you were away",
        created_at: downtime,
        updated_at: downtime,
      }),
    ]);

    const bot = makeBot();
    await bot.start();
    await bot.poll();
    await settleQueues();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    // Poll re-fetches with an overlap window behind the persisted cursor.
    const since = client.listIssueCommentsSince.mock.calls[0][2] as string;
    expect(Date.parse(since)).toBeLessThan(Date.parse(cursor));
  });

  test("ids already in the persisted watermark never re-trigger", async () => {
    const statePath = join(workingDir, "state", "github-sync.json");
    mkdirSync(join(workingDir, "state"), { recursive: true });
    const baseline = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      statePath,
      JSON.stringify({
        repos: {
          "octo/widgets": { baseline, cursor: baseline, seenComments: [9001], seenIssues: [] },
        },
      }),
    );
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "@mikan ping" })]);

    const bot = makeBot();
    await bot.start();
    await bot.poll();
    await settleQueues();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("postMessage posts a comment and returns its id", async () => {
    const bot = makeBot();
    await bot.start();
    expect(await bot.postMessage(CONVERSATION_ID, "hello")).toBe("555");
    expect(client.createIssueComment).toHaveBeenCalledWith("octo", "widgets", 5, "hello");
  });

  test("addReaction maps short names and routes issue-body vs comment", async () => {
    const bot = makeBot();
    await bot.start();

    await bot.addReaction(CONVERSATION_ID, "9001", "eyes");
    expect(client.createCommentReaction).toHaveBeenCalledWith("octo", "widgets", 9001, "eyes");

    await bot.addReaction(CONVERSATION_ID, GITHUB_ISSUE_BODY_TS, "tada");
    expect(client.createIssueReaction).toHaveBeenCalledWith("octo", "widgets", 5, "hooray");

    await expect(bot.addReaction(CONVERSATION_ID, "9001", "sparkles")).rejects.toThrow(
      /does not support reaction/,
    );
  });

  test("commenters below the trigger permission are ignored entirely", async () => {
    client.getCollaboratorPermission.mockResolvedValue({ permission: "read" });
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "@mikan do things" })]);

    await bot.poll();
    await settleQueues();

    expect(client.getCollaboratorPermission).toHaveBeenCalledWith("octo", "widgets", "alice");
    expect(handler.handleEvent).not.toHaveBeenCalled();
    expect(existsSync(join(workingDir, CONVERSATION_ID))).toBe(false);
  });

  test("custom roles fall back to the stronger legacy permission field", async () => {
    client.getCollaboratorPermission.mockResolvedValue({
      permission: "write",
      role_name: "custom-deployer",
    });
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "@mikan hi" })]);

    await bot.poll();
    await settleQueues();
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
  });

  test("permission lookups are cached per repo+user", async () => {
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([
      makeComment({ id: 1, body: "@mikan one" }),
      makeComment({ id: 2, body: "@mikan two" }),
    ]);

    await bot.poll();
    await settleQueues();

    expect(handler.handleEvent).toHaveBeenCalledTimes(2);
    expect(client.getCollaboratorPermission).toHaveBeenCalledTimes(1);
  });

  test("a failed permission lookup denies the trigger (fails closed)", async () => {
    client.getCollaboratorPermission.mockRejectedValue(new Error("boom"));
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "@mikan hi" })]);

    await bot.poll();
    await settleQueues();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("first contact clones the repo with a read-scoped token", async () => {
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "@mikan look" })]);

    await bot.poll();
    await settleQueues();

    expect(client.createScopedInstallationToken).toHaveBeenCalledWith("widgets", {
      contents: "read",
    });
    expect(cloneRepo).toHaveBeenCalledWith({
      url: "https://github.com/octo/widgets.git",
      dir: join(workingDir, CONVERSATION_ID, "repo"),
      token: "scoped-token",
      botLogin: "mikan[bot]",
      botEmail: "999+mikan[bot]@users.noreply.github.com",
      prNumber: undefined,
    });
  });

  test("PR conversations check out the PR head on clone", async () => {
    const bot = makeBot();
    await bot.start();
    client.listIssuesSince.mockResolvedValue([
      makeIssue({ body: "@mikan review this", pull_request: {} }),
    ]);

    await bot.poll();
    await settleQueues();

    expect(cloneRepo).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 5 }));
  });

  test("ignored comments never mint tokens or clone", async () => {
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "unrelated" })]);

    await bot.poll();
    await settleQueues();

    expect(client.createScopedInstallationToken).not.toHaveBeenCalled();
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  test("an existing clone is not re-cloned on later first-contact paths", async () => {
    mkdirSync(join(workingDir, CONVERSATION_ID, "repo"), { recursive: true });
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "@mikan again" })]);

    await bot.poll();
    await settleQueues();
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  test("a participating conversation with a missing clone retries on the next trigger", async () => {
    // Simulate a conversation whose first-contact clone failed (log exists,
    // repo dir does not) — e.g. App permissions were granted only later.
    mkdirSync(join(workingDir, CONVERSATION_ID), { recursive: true });
    writeFileSync(join(workingDir, CONVERSATION_ID, "log.jsonl"), "{}\n");
    client.getIssue.mockResolvedValue(makeIssue({ pull_request: {} }));
    const bot = makeBot();
    await bot.start();
    client.listIssueCommentsSince.mockResolvedValue([makeComment({ body: "try again" })]);

    await bot.poll();
    await settleQueues();

    expect(cloneRepo).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 5 }));
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
  });

  test("pushAndCreatePr pushes the branch with a write token and opens the PR", async () => {
    mkdirSync(join(workingDir, CONVERSATION_ID, "repo"), { recursive: true });
    const bot = makeBot();
    await bot.start();

    const result = await bot.pushAndCreatePr(CONVERSATION_ID, {
      branch: "pi/fix-5",
      title: "Fix the widget",
      body: "Closes #5",
      draft: true,
    });

    expect(client.createScopedInstallationToken).toHaveBeenCalledWith("widgets", {
      contents: "write",
      pull_requests: "write",
    });
    expect(pushBranch).toHaveBeenCalledWith({
      dir: join(workingDir, CONVERSATION_ID, "repo"),
      branch: "pi/fix-5",
      token: "scoped-token",
    });
    expect(client.createPullRequest).toHaveBeenCalledWith("octo", "widgets", {
      title: "Fix the widget",
      head: "pi/fix-5",
      base: "main",
      body: "Closes #5",
      draft: true,
    });
    expect(result).toEqual({ number: 7, url: "https://github.com/octo/widgets/pull/7" });
  });

  test("pushAndCreatePr returns the existing open PR when the branch already has one", async () => {
    mkdirSync(join(workingDir, CONVERSATION_ID, "repo"), { recursive: true });
    const { GithubApiError } = await import("../src/adapters/github/client.js");
    client.createPullRequest.mockRejectedValue(
      new GithubApiError(422, "POST", "/repos/octo/widgets/pulls", "A pull request already exists"),
    );
    client.findOpenPullRequestByBranch = vi.fn().mockResolvedValue({
      number: 7,
      html_url: "https://github.com/octo/widgets/pull/7",
    });
    const bot = makeBot();
    await bot.start();

    const result = await bot.pushAndCreatePr(CONVERSATION_ID, { branch: "pi/fix-5", title: "t" });

    expect(pushBranch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      number: 7,
      url: "https://github.com/octo/widgets/pull/7",
      updatedExisting: true,
    });
  });

  test("getChecks reads a branch's check runs, or the PR head when omitted", async () => {
    client.listCheckRuns = vi.fn().mockResolvedValue([
      {
        id: 42,
        name: "test",
        status: "completed",
        conclusion: "success",
        html_url: "https://ci/1",
        app: { slug: "github-actions" },
        output: { title: "ok", summary: "all green" },
      },
    ]);
    client.getPullRequest = vi
      .fn()
      .mockResolvedValue({ number: 5, html_url: "u", head: { ref: "feat", sha: "abc123" } });
    const bot = makeBot();
    await bot.start();

    expect(await bot.getChecks(CONVERSATION_ID, "pi/fix-5")).toEqual([
      {
        id: 42,
        name: "test",
        status: "completed",
        conclusion: "success",
        url: "https://ci/1",
        appSlug: "github-actions",
        outputSummary: "all green",
      },
    ]);
    expect(client.listCheckRuns).toHaveBeenLastCalledWith("octo", "widgets", "pi/fix-5");

    await bot.getChecks(CONVERSATION_ID);
    expect(client.listCheckRuns).toHaveBeenLastCalledWith("octo", "widgets", "abc123");
  });

  test("getJobLog truncates to the tail of huge logs", async () => {
    client.getJobLog = vi.fn().mockResolvedValue(`${"x".repeat(30000)}TAIL`);
    const bot = makeBot();
    await bot.start();

    const logText = await bot.getJobLog(CONVERSATION_ID, 42);
    expect(client.getJobLog).toHaveBeenCalledWith("octo", "widgets", 42);
    expect(logText).toContain("truncated to the last 20000 chars");
    expect(logText.endsWith("TAIL")).toBe(true);
    expect(logText.length).toBeLessThan(21000);
  });

  test("getJobLog rejects invalid ids and translates 404 into guidance", async () => {
    const { GithubApiError } = await import("../src/adapters/github/client.js");
    client.getJobLog = vi
      .fn()
      .mockRejectedValue(
        new GithubApiError(404, "GET", "/repos/octo/widgets/actions/jobs/9/logs", "Not Found"),
      );
    const bot = makeBot();
    await bot.start();

    await expect(bot.getJobLog(CONVERSATION_ID, 0)).rejects.toThrow(/positive Actions job id/);
    expect(client.getJobLog).not.toHaveBeenCalled();
    await expect(bot.getJobLog(CONVERSATION_ID, 9)).rejects.toThrow(/Do not retry/);
  });

  test("getChecks without a branch demands one when the conversation is a plain issue", async () => {
    client.getPullRequest = vi.fn().mockRejectedValue(new Error("404"));
    const bot = makeBot();
    await bot.start();
    await expect(bot.getChecks(CONVERSATION_ID)).rejects.toThrow(/pass the branch/);
  });

  test("pushAndCreatePr refuses non-pi branches and missing clones", async () => {
    const bot = makeBot();
    await bot.start();

    await expect(
      bot.pushAndCreatePr(CONVERSATION_ID, { branch: "pi/x", title: "t" }),
    ).rejects.toThrow(/no \.\/repo clone/);

    mkdirSync(join(workingDir, CONVERSATION_ID, "repo"), { recursive: true });
    await expect(
      bot.pushAndCreatePr(CONVERSATION_ID, { branch: "main", title: "t" }),
    ).rejects.toThrow(/not pushable/);
    expect(pushBranch).not.toHaveBeenCalled();
  });
});
