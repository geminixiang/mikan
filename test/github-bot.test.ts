import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MessagingEventHandler, OfficeAddress } from "../src/adapter.js";
import { createOfficeAddress, createWorkspace, officeKey } from "../src/office/index.js";
import { conversationIdOf } from "../src/sessions/session-key.js";
import { GithubMessagingBot } from "../src/adapters/github/bot.js";
import type { GithubClient } from "../src/adapters/github/client.js";
import {
  buildGithubConversationId,
  GITHUB_ISSUE_BODY_TS,
  parseGithubConversationId,
} from "../src/adapters/github/ids.js";
import { cloneRepo, pushBranch, syncRepo } from "../src/adapters/github/repo.js";
import { fetchCloudBuildLog } from "../src/adapters/github/cloudbuild.js";
import type { GcpTokenProvider } from "../src/adapters/github/gcp-auth.js";
import type {
  GithubIssue,
  GithubIssueComment,
  GithubReviewComment,
} from "../src/adapters/github/types.js";

vi.mock("../src/adapters/github/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/github/repo.js")>();
  return {
    ...actual,
    cloneRepo: vi.fn().mockResolvedValue(undefined),
    pushBranch: vi.fn().mockResolvedValue(undefined),
    syncRepo: vi.fn().mockResolvedValue({
      target: "pr-5",
      fetchedSha: "abc123def4567890",
      updatedCheckout: true,
      dirty: false,
      currentBranch: "pr-5",
      localCommits: 0,
    }),
  };
});

vi.mock("../src/adapters/github/cloudbuild.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/github/cloudbuild.js")>();
  return {
    ...actual,
    fetchCloudBuildLog: vi.fn().mockResolvedValue("cloud build log"),
  };
});

function makeHandler(runningKeys: string[] = []): MessagingEventHandler {
  const running = new Set(runningKeys);
  return {
    isRunning: vi.fn((_address: OfficeAddress, key: string) => running.has(key)),
    getRunningSessions: vi.fn().mockReturnValue(
      [...running].map((sessionKey) => ({
        address: createOfficeAddress("github", conversationIdOf(sessionKey)),
        sessionKey,
        startedAt: Date.now(),
      })),
    ),
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

function makeReviewComment(overrides: Partial<GithubReviewComment> = {}): GithubReviewComment {
  const createdAt = futureIso();
  return {
    id: 8001,
    body: "@mikan please rename this",
    user: { login: "alice", type: "User" },
    created_at: createdAt,
    updated_at: createdAt,
    pull_request_url: "https://api.github.com/repos/octo/widgets/pulls/5",
    path: "src/widget.ts",
    line: 42,
    diff_hunk: "@@ -40,3 +40,3 @@\n-const a = 1;\n+const widgetCount = 1;",
    ...overrides,
  };
}

interface FakeClient {
  getAppSlug: ReturnType<typeof vi.fn>;
  getUserId: ReturnType<typeof vi.fn>;
  listInstallationRepositories: ReturnType<typeof vi.fn>;
  listIssuesSince: ReturnType<typeof vi.fn>;
  listIssueCommentsSince: ReturnType<typeof vi.fn>;
  listPullReviewCommentsSince: ReturnType<typeof vi.fn>;
  listPullReviewComments: ReturnType<typeof vi.fn>;
  createReviewCommentReaction: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  createIssueComment: ReturnType<typeof vi.fn>;
  updateIssueComment: ReturnType<typeof vi.fn>;
  deleteIssueComment: ReturnType<typeof vi.fn>;
  createCommentReaction: ReturnType<typeof vi.fn>;
  createIssueReaction: ReturnType<typeof vi.fn>;
  createScopedInstallationToken: ReturnType<typeof vi.fn>;
  getRepository: ReturnType<typeof vi.fn>;
  createPullRequest: ReturnType<typeof vi.fn>;
  getPullRequest: ReturnType<typeof vi.fn>;
  getCollaboratorPermission: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return {
    getAppSlug: vi.fn().mockResolvedValue("mikan"),
    getUserId: vi.fn().mockResolvedValue(999),
    listInstallationRepositories: vi.fn().mockResolvedValue([]),
    listIssuesSince: vi.fn().mockResolvedValue([]),
    listIssueCommentsSince: vi.fn().mockResolvedValue([]),
    listPullReviewCommentsSince: vi.fn().mockResolvedValue([]),
    listPullReviewComments: vi.fn().mockResolvedValue([]),
    createReviewCommentReaction: vi.fn().mockResolvedValue(undefined),
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
    getPullRequest: vi.fn().mockResolvedValue({
      number: 5,
      html_url: "https://github.com/octo/widgets/pull/5",
      head: { ref: "pi/fix-widget", sha: "headsha", repo: { full_name: "octo/widgets" } },
    }),
  };
}

const CONVERSATION_ID = "GH_octo_widgets_5";
const CONVERSATION_OFFICE = officeKey(createOfficeAddress("github", CONVERSATION_ID));

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
    vi.mocked(syncRepo).mockClear();
  });

  afterEach(() => {
    if (existsSync(workingDir)) rmSync(workingDir, { recursive: true, force: true });
  });

  function makeBot(
    overrides: {
      handler?: MessagingEventHandler;
      repos?: string[];
      cloudBuild?: { tokenProvider: GcpTokenProvider; projectFallback?: string };
    } = {},
  ) {
    return new GithubMessagingBot(
      overrides.handler ?? handler,
      {
        appId: "1",
        privateKey: "unused",
        installationId: "2",
        repos: overrides.repos ?? ["octo/widgets"],
        pollIntervalMs: 60_000,
        workspace: createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") }),
        syncStatePath: join(workingDir, "state", "github-sync.json"),
        cloudBuild: overrides.cloudBuild,
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

    const lines = readFileSync(join(workingDir, CONVERSATION_OFFICE, "log.jsonl"), "utf-8")
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
    expect(existsSync(join(workingDir, CONVERSATION_OFFICE))).toBe(false);
  });

  test("unmentioned comment in a participating conversation triggers", async () => {
    mkdirSync(join(workingDir, CONVERSATION_OFFICE, "repo"), { recursive: true });
    writeFileSync(join(workingDir, CONVERSATION_OFFICE, "log.jsonl"), "{}\n");
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

    expect(stopHandler.handleStop).toHaveBeenCalledWith(
      createOfficeAddress("github", CONVERSATION_ID),
      CONVERSATION_ID,
      bot,
    );
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
    expect(existsSync(join(workingDir, CONVERSATION_OFFICE))).toBe(false);
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
      dir: join(workingDir, CONVERSATION_OFFICE, "repo"),
      token: "scoped-token",
      botLogin: "mikan[bot]",
      botEmail: "999+mikan[bot]@users.noreply.github.com",
      prNumber: undefined,
    });
  });

  test("PR conversations check out the PR head under its real branch name on clone", async () => {
    const bot = makeBot();
    await bot.start();
    client.listIssuesSince.mockResolvedValue([
      makeIssue({ body: "@mikan review this", pull_request: {} }),
    ]);

    await bot.poll();
    await settleQueues();

    expect(cloneRepo).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 5, prHeadBranch: "pi/fix-widget" }),
    );
  });

  test("fork PRs clone without a head branch name (checkout falls back to pr-<n>)", async () => {
    client.getPullRequest.mockResolvedValue({
      number: 5,
      html_url: "https://github.com/octo/widgets/pull/5",
      head: { ref: "feature", sha: "headsha", repo: { full_name: "alice/widgets" } },
    });
    const bot = makeBot();
    await bot.start();
    client.listIssuesSince.mockResolvedValue([
      makeIssue({ body: "@mikan review this", pull_request: {} }),
    ]);

    await bot.poll();
    await settleQueues();

    expect(cloneRepo).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 5, prHeadBranch: undefined }),
    );
  });

  test("a failed PR head lookup still clones, falling back to pr-<n>", async () => {
    client.getPullRequest.mockRejectedValue(new Error("boom"));
    const bot = makeBot();
    await bot.start();
    client.listIssuesSince.mockResolvedValue([
      makeIssue({ body: "@mikan review this", pull_request: {} }),
    ]);

    await bot.poll();
    await settleQueues();

    expect(cloneRepo).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 5, prHeadBranch: undefined }),
    );
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
    mkdirSync(join(workingDir, CONVERSATION_OFFICE, "repo"), { recursive: true });
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
    mkdirSync(join(workingDir, CONVERSATION_OFFICE), { recursive: true });
    writeFileSync(join(workingDir, CONVERSATION_OFFICE, "log.jsonl"), "{}\n");
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
    mkdirSync(join(workingDir, CONVERSATION_OFFICE, "repo"), { recursive: true });
    const bot = makeBot();
    await bot.start();

    const result = await bot.ops.pushAndCreatePr(CONVERSATION_ID, {
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
      dir: join(workingDir, CONVERSATION_OFFICE, "repo"),
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
    mkdirSync(join(workingDir, CONVERSATION_OFFICE, "repo"), { recursive: true });
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

    const result = await bot.ops.pushAndCreatePr(CONVERSATION_ID, {
      branch: "pi/fix-5",
      title: "t",
    });

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

    expect(await bot.ops.getChecks(CONVERSATION_ID, "pi/fix-5")).toEqual([
      {
        id: 42,
        name: "test",
        status: "completed",
        conclusion: "success",
        url: "https://ci/1",
        appSlug: "github-actions",
        outputSummary: "all green",
        externalId: null,
        buildLogAvailable: false,
      },
    ]);
    expect(client.listCheckRuns).toHaveBeenLastCalledWith("octo", "widgets", "pi/fix-5");

    await bot.ops.getChecks(CONVERSATION_ID);
    expect(client.listCheckRuns).toHaveBeenLastCalledWith("octo", "widgets", "abc123");
  });

  test("getChecks marks Cloud Build runs fetchable only with GCP creds and a project", async () => {
    const BUILD_ID = "12345678-1234-1234-1234-123456789abc";
    const cloudBuildRun = {
      id: 60,
      name: "cloudbuild",
      status: "completed",
      conclusion: "failure",
      html_url: "https://cb/60",
      app: { slug: "google-cloud-build" },
      output: null,
      external_id: BUILD_ID,
      details_url: `https://console.cloud.google.com/cloud-build/builds/${BUILD_ID}?project=123`,
    };
    client.listCheckRuns = vi.fn().mockResolvedValue([cloudBuildRun]);
    const tokenProvider = { getAccessToken: vi.fn() } as unknown as GcpTokenProvider;

    // Without GCP creds the run is external CI as before.
    const plainBot = makeBot();
    await plainBot.start();
    const [plainRun] = await plainBot.ops.getChecks(CONVERSATION_ID, "pi/x");
    expect(plainRun.externalId).toBe(BUILD_ID);
    expect(plainRun.buildLogAvailable).toBe(false);

    // With creds and a project in details_url the log is advertised.
    const bot = makeBot({ cloudBuild: { tokenProvider } });
    await bot.start();
    const [run] = await bot.ops.getChecks(CONVERSATION_ID, "pi/x");
    expect(run.buildLogAvailable).toBe(true);

    // No project anywhere → not advertised (fallback would fix it).
    client.listCheckRuns = vi
      .fn()
      .mockResolvedValue([{ ...cloudBuildRun, details_url: "https://console/no-project" }]);
    const [noProject] = await bot.ops.getChecks(CONVERSATION_ID, "pi/x");
    expect(noProject.buildLogAvailable).toBe(false);

    const fallbackBot = makeBot({
      cloudBuild: { tokenProvider, projectFallback: "fallback-project" },
    });
    await fallbackBot.start();
    const [viaFallback] = await fallbackBot.ops.getChecks(CONVERSATION_ID, "pi/x");
    expect(viaFallback.buildLogAvailable).toBe(true);
  });

  test("getBuildLog serves only builds seen in a summary and truncates the tail", async () => {
    const BUILD_ID = "12345678-1234-1234-1234-123456789abc";
    client.listCheckRuns = vi.fn().mockResolvedValue([
      {
        id: 60,
        name: "cloudbuild",
        status: "completed",
        conclusion: "failure",
        html_url: null,
        app: { slug: "google-cloud-build" },
        output: null,
        external_id: BUILD_ID,
        details_url: `https://console/builds/${BUILD_ID}?project=123`,
      },
    ]);
    const tokenProvider = { getAccessToken: vi.fn() } as unknown as GcpTokenProvider;
    const bot = makeBot({ cloudBuild: { tokenProvider } });
    await bot.start();

    // Not seen yet → guidance to run the summary first.
    await expect(bot.ops.getBuildLog(CONVERSATION_ID, BUILD_ID)).rejects.toThrow(
      /run github_checks first/,
    );

    await bot.ops.getChecks(CONVERSATION_ID, "pi/x");
    vi.mocked(fetchCloudBuildLog).mockResolvedValue(`${"x".repeat(30000)}TAIL`);

    const logText = await bot.ops.getBuildLog(CONVERSATION_ID, BUILD_ID);
    expect(fetchCloudBuildLog).toHaveBeenCalledWith({
      tokenProvider,
      project: "123",
      buildId: BUILD_ID,
    });
    expect(logText).toContain("truncated to the last 20000 chars");
    expect(logText.endsWith("TAIL")).toBe(true);
  });

  test("getBuildLog without GCP creds explains the feature is not configured", async () => {
    const bot = makeBot();
    await bot.start();
    await expect(
      bot.ops.getBuildLog(CONVERSATION_ID, "12345678-1234-1234-1234-123456789abc"),
    ).rejects.toThrow(/not configured on this host/);
  });

  test("getJobLog truncates to the tail of huge logs", async () => {
    client.getJobLog = vi.fn().mockResolvedValue(`${"x".repeat(30000)}TAIL`);
    const bot = makeBot();
    await bot.start();

    const logText = await bot.ops.getJobLog(CONVERSATION_ID, 42);
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

    await expect(bot.ops.getJobLog(CONVERSATION_ID, 0)).rejects.toThrow(/positive Actions job id/);
    expect(client.getJobLog).not.toHaveBeenCalled();
    await expect(bot.ops.getJobLog(CONVERSATION_ID, 9)).rejects.toThrow(/Do not retry/);
  });

  test("getChecks without a branch demands one when the conversation is a plain issue", async () => {
    client.getPullRequest = vi.fn().mockRejectedValue(new Error("404"));
    const bot = makeBot();
    await bot.start();
    await expect(bot.ops.getChecks(CONVERSATION_ID)).rejects.toThrow(/pass the branch/);
  });

  test("mentioned review comment triggers with diff anchor context and rc- ts", async () => {
    const bot = makeBot();
    await bot.start();
    client.listPullReviewCommentsSince.mockResolvedValue([makeReviewComment()]);

    await bot.poll();
    await settleQueues();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    const [event] = vi.mocked(handler.handleEvent).mock.calls[0];
    expect(event.conversationId).toBe(CONVERSATION_ID);
    expect(event.ts).toBe("rc-8001");
    expect(event.text).toContain("[PR review comment rc-8001 on src/widget.ts:42]");
    expect(event.text).toContain("```diff");
    expect(event.text).toContain("+const widgetCount = 1;");
    expect(event.text).toContain("please rename this");
    expect(event.text).not.toContain("@mikan");
    // Review comments only exist on PRs; first contact clones the PR head.
    expect(cloneRepo).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 5 }));
  });

  test("bot-authored and below-permission review comments do not trigger", async () => {
    client.getCollaboratorPermission.mockResolvedValue({ permission: "read" });
    const bot = makeBot();
    await bot.start();
    client.listPullReviewCommentsSince.mockResolvedValue([
      makeReviewComment({ id: 1, user: { login: "mikan[bot]", type: "Bot" } }),
      makeReviewComment({ id: 2, user: { login: "drive-by", type: "User" } }),
    ]);

    await bot.poll();
    await settleQueues();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("a review comment id seen once does not re-trigger, even when edits re-list it", async () => {
    const bot = makeBot();
    await bot.start();
    const comment = makeReviewComment();
    client.listPullReviewCommentsSince.mockResolvedValue([comment]);
    await bot.poll();

    client.listPullReviewCommentsSince.mockResolvedValue([
      { ...comment, updated_at: futureIso(120_000) },
    ]);
    await bot.poll();
    await settleQueues();
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
  });

  test("pre-baseline review comments never trigger", async () => {
    const bot = makeBot();
    await bot.start();
    client.listPullReviewCommentsSince.mockResolvedValue([
      makeReviewComment({
        created_at: new Date(Date.now() - 60_000).toISOString(),
        updated_at: futureIso(),
      }),
    ]);

    await bot.poll();
    await settleQueues();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("sync state written before review polling loads and self-upgrades", async () => {
    const statePath = join(workingDir, "state", "github-sync.json");
    mkdirSync(join(workingDir, "state"), { recursive: true });
    const baseline = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    // Old-format file: no seenReviewComments field.
    writeFileSync(
      statePath,
      JSON.stringify({
        repos: {
          "octo/widgets": { baseline, cursor: baseline, seenComments: [9001], seenIssues: [] },
        },
      }),
    );
    const downtime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    client.listPullReviewCommentsSince.mockResolvedValue([
      makeReviewComment({ created_at: downtime, updated_at: downtime }),
    ]);

    const bot = makeBot();
    await bot.start();
    await bot.poll();
    await settleQueues();

    // Baseline survived (no re-baseline): the downtime review comment triggers,
    // and the old seenComments dedup state is intact.
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.repos["octo/widgets"].seenComments).toEqual([9001]);
    expect(state.repos["octo/widgets"].seenReviewComments).toEqual([8001]);
  });

  test("a mid-thread reply carries the thread's earlier turns", async () => {
    const bot = makeBot();
    await bot.start();
    client.listPullReviewComments.mockResolvedValue([
      makeReviewComment({
        id: 7000,
        body: "root: why this name?",
        user: { login: "bob", type: "User" },
      }),
      makeReviewComment({ id: 7500, body: "because clarity", in_reply_to_id: 7000 }),
      makeReviewComment({ id: 8001, body: "@mikan settle this", in_reply_to_id: 7000 }),
    ]);
    client.listPullReviewCommentsSince.mockResolvedValue([
      makeReviewComment({ id: 8001, body: "@mikan settle this", in_reply_to_id: 7000 }),
    ]);

    await bot.poll();
    await settleQueues();

    const [event] = vi.mocked(handler.handleEvent).mock.calls[0];
    expect(event.text).toContain("Thread so far:");
    expect(event.text).toContain("@bob: root: why this name?");
    expect(event.text).toContain("@alice: because clarity");
    // The triggering comment itself is not repeated as a prior turn.
    expect(event.text.indexOf("settle this")).toBe(event.text.lastIndexOf("settle this"));
  });

  test("a thread-root review comment does not fetch thread context", async () => {
    const bot = makeBot();
    await bot.start();
    client.listPullReviewCommentsSince.mockResolvedValue([makeReviewComment()]);

    await bot.poll();
    await settleQueues();

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(client.listPullReviewComments).not.toHaveBeenCalled();
  });

  test("syncRepo requires a clone, mints a read token, and targets the PR head", async () => {
    const bot = makeBot();
    await bot.start();

    await expect(bot.ops.syncRepo(CONVERSATION_ID)).rejects.toThrow(/no \.\/repo clone/);

    mkdirSync(join(workingDir, CONVERSATION_OFFICE, "repo"), { recursive: true });
    client.getIssue.mockResolvedValue(makeIssue({ pull_request: {} }));

    const report = await bot.ops.syncRepo(CONVERSATION_ID);

    expect(client.createScopedInstallationToken).toHaveBeenCalledWith("widgets", {
      contents: "read",
    });
    expect(syncRepo).toHaveBeenCalledWith({
      dir: join(workingDir, CONVERSATION_OFFICE, "repo"),
      token: "scoped-token",
      branch: undefined,
      prNumber: 5,
      prHeadBranch: "pi/fix-widget",
      defaultBranch: undefined,
    });
    expect(report).toContain("Updated ./repo");
    expect(report).toContain("pr-5");
  });

  test("syncRepo falls back to the default branch on plain issues and reports fetch-only", async () => {
    mkdirSync(join(workingDir, CONVERSATION_OFFICE, "repo"), { recursive: true });
    client.getIssue.mockResolvedValue(makeIssue());
    vi.mocked(syncRepo).mockResolvedValue({
      target: "main",
      fetchedSha: "abc123def4567890",
      updatedCheckout: false,
      dirty: true,
      currentBranch: "main",
      localCommits: 2,
    });
    const bot = makeBot();
    await bot.start();

    const report = await bot.ops.syncRepo(CONVERSATION_ID);

    expect(syncRepo).toHaveBeenCalledWith(
      expect.objectContaining({ defaultBranch: "main", prNumber: undefined }),
    );
    expect(report).toContain("left the checkout alone");
    expect(report).toContain("uncommitted changes");
    expect(report).toContain("2 local commit(s)");
  });

  test("readGithub defaults to the conversation's number and scopes to its repo", async () => {
    client.getPullRequest = vi.fn().mockResolvedValue({ number: 5, html_url: "u" });
    client.listPullRequestFiles = vi.fn().mockResolvedValue([]);
    client.listIssues = vi.fn().mockResolvedValue([]);
    const bot = makeBot();
    await bot.start();

    const prResult = await bot.ops.readGithub(CONVERSATION_ID, { action: "pr" });
    expect(client.getPullRequest).toHaveBeenCalledWith("octo", "widgets", 5);
    expect(prResult).toEqual({ kind: "pr", pr: { number: 5, html_url: "u" } });

    await bot.ops.readGithub(CONVERSATION_ID, { action: "pr_files", number: 12 });
    expect(client.listPullRequestFiles).toHaveBeenCalledWith("octo", "widgets", 12);

    await bot.ops.readGithub(CONVERSATION_ID, { action: "list", labels: "bug", state: "all" });
    expect(client.listIssues).toHaveBeenCalledWith("octo", "widgets", {
      state: "all",
      labels: "bug",
      creator: undefined,
    });
  });

  test("readGithub pr_reviews returns reviews and inline threads together", async () => {
    client.listPullRequestReviews = vi
      .fn()
      .mockResolvedValue([
        { id: 1, user: { login: "bob", type: "User" }, state: "APPROVED", body: null },
      ]);
    const bot = makeBot();
    await bot.start();

    const result = await bot.ops.readGithub(CONVERSATION_ID, { action: "pr_reviews" });

    expect(client.listPullRequestReviews).toHaveBeenCalledWith("octo", "widgets", 5);
    expect(client.listPullReviewComments).toHaveBeenCalledWith("octo", "widgets", 5);
    expect(result.kind).toBe("pr_reviews");
  });

  test("manageIssue hits each endpoint with validated params", async () => {
    client.addIssueLabels = vi.fn().mockResolvedValue(undefined);
    client.removeIssueLabel = vi.fn().mockResolvedValue(undefined);
    client.addIssueAssignees = vi.fn().mockResolvedValue(undefined);
    client.removeIssueAssignees = vi.fn().mockResolvedValue(undefined);
    client.updateIssueState = vi.fn().mockResolvedValue(undefined);
    const bot = makeBot();
    await bot.start();

    await bot.ops.manageIssue(CONVERSATION_ID, { action: "add_labels", labels: ["bug", "p1"] });
    expect(client.addIssueLabels).toHaveBeenCalledWith("octo", "widgets", 5, ["bug", "p1"]);

    await bot.ops.manageIssue(CONVERSATION_ID, { action: "remove_label", number: 9, label: "p1" });
    expect(client.removeIssueLabel).toHaveBeenCalledWith("octo", "widgets", 9, "p1");

    await bot.ops.manageIssue(CONVERSATION_ID, { action: "add_assignees", assignees: ["alice"] });
    expect(client.addIssueAssignees).toHaveBeenCalledWith("octo", "widgets", 5, ["alice"]);

    await bot.ops.manageIssue(CONVERSATION_ID, {
      action: "remove_assignees",
      assignees: ["alice"],
    });
    expect(client.removeIssueAssignees).toHaveBeenCalledWith("octo", "widgets", 5, ["alice"]);

    const closed = await bot.ops.manageIssue(CONVERSATION_ID, {
      action: "close",
      state_reason: "not_planned",
    });
    expect(client.updateIssueState).toHaveBeenCalledWith(
      "octo",
      "widgets",
      5,
      "closed",
      "not_planned",
    );
    expect(closed).toContain("not_planned");

    await bot.ops.manageIssue(CONVERSATION_ID, { action: "reopen" });
    expect(client.updateIssueState).toHaveBeenLastCalledWith("octo", "widgets", 5, "open");
  });

  test("manageIssue rejects missing params and translates 404", async () => {
    const { GithubApiError } = await import("../src/adapters/github/client.js");
    client.addIssueLabels = vi.fn().mockResolvedValue(undefined);
    client.updateIssueState = vi
      .fn()
      .mockRejectedValue(new GithubApiError(404, "PATCH", "/x", "Not Found"));
    const bot = makeBot();
    await bot.start();

    await expect(bot.ops.manageIssue(CONVERSATION_ID, { action: "add_labels" })).rejects.toThrow(
      /requires a non-empty labels array/,
    );
    await expect(bot.ops.manageIssue(CONVERSATION_ID, { action: "remove_label" })).rejects.toThrow(
      /requires a label name/,
    );
    await expect(
      bot.ops.manageIssue(CONVERSATION_ID, { action: "close", number: 9999 }),
    ).rejects.toThrow(/Issue #9999 not found in octo\/widgets/);
  });

  test("replyToReviewThread posts into the thread and returns the discussion url", async () => {
    client.replyToReviewComment = vi.fn().mockResolvedValue(makeReviewComment({ id: 9002 }));
    const bot = makeBot();
    await bot.start();

    const result = await bot.ops.replyToReviewThread(CONVERSATION_ID, 8001, "done");

    expect(client.replyToReviewComment).toHaveBeenCalledWith("octo", "widgets", 5, 8001, "done");
    expect(result.url).toBe("https://github.com/octo/widgets/pull/5#discussion_r9002");
  });

  test("replyToReviewThread rejects bad ids and translates 404 into guidance", async () => {
    const { GithubApiError } = await import("../src/adapters/github/client.js");
    client.replyToReviewComment = vi
      .fn()
      .mockRejectedValue(new GithubApiError(404, "POST", "/x", "Not Found"));
    const bot = makeBot();
    await bot.start();

    await expect(bot.ops.replyToReviewThread(CONVERSATION_ID, 0, "x")).rejects.toThrow(
      /numeric id from an \[PR review comment/,
    );
    expect(client.replyToReviewComment).not.toHaveBeenCalled();
    await expect(bot.ops.replyToReviewThread(CONVERSATION_ID, 123, "x")).rejects.toThrow(
      /not a review comment on this PR/,
    );
  });

  test("addReaction routes rc- ts to the review-comment reactions endpoint", async () => {
    const bot = makeBot();
    await bot.start();

    await bot.addReaction(CONVERSATION_ID, "rc-8001", "eyes");
    expect(client.createReviewCommentReaction).toHaveBeenCalledWith(
      "octo",
      "widgets",
      8001,
      "eyes",
    );
    expect(client.createCommentReaction).not.toHaveBeenCalled();
  });

  test("pushAndCreatePr refuses non-pi branches and missing clones", async () => {
    const bot = makeBot();
    await bot.start();

    await expect(
      bot.ops.pushAndCreatePr(CONVERSATION_ID, { branch: "pi/x", title: "t" }),
    ).rejects.toThrow(/no \.\/repo clone/);

    mkdirSync(join(workingDir, CONVERSATION_OFFICE, "repo"), { recursive: true });
    await expect(
      bot.ops.pushAndCreatePr(CONVERSATION_ID, { branch: "main", title: "t" }),
    ).rejects.toThrow(/not pushable/);
    expect(pushBranch).not.toHaveBeenCalled();
  });
});
