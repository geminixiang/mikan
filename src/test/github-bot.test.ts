import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from "vitest";
import type { MessagingEventHandler, OfficeAddress } from "../types.js";
import { conversationIdOf } from "../sessions/session-key.js";
import { GithubMessagingBot } from "../adapters/github/bot.js";
import {
  buildGithubConversationId,
  createOfficeAddress,
  createWorkspace,
  officeKey,
  parseGithubConversationId,
} from "../office/index.js";
import {
  GITHUB_ISSUE_BODY_TS,
  githubReviewCommentTs,
  parseReviewCommentTs,
} from "../adapters/github/ids.js";
import { cloneRepo, pushBranch, syncRepo } from "../adapters/github/repo.js";
import type {
  GithubApi,
  GithubIssue,
  GithubIssueComment,
  GithubPolicy,
  GithubReviewComment,
  GithubWebhookDelivery,
} from "../adapters/github/types.js";

vi.mock("../adapters/github/repo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../adapters/github/repo.js")>();
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

const AGENT_TOKEN = "agent-token";

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

function firstHandledEvent(handler: MessagingEventHandler) {
  const call = vi.mocked(handler.handleEvent).mock.calls[0];
  if (!call) throw new Error("handleEvent was not called");
  return call;
}

const CREATED_AT = "2026-09-30T10:00:00Z";
const ALICE = { login: "alice", type: "User" };
const REPOSITORY = { name: "widgets", private: true, owner: { login: "octo" } };

function makeComment(overrides: Partial<GithubIssueComment> = {}): GithubIssueComment {
  return {
    id: 9001,
    body: "hello",
    user: ALICE,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    issue_url: "https://api.github.com/repos/octo/widgets/issues/5",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<GithubIssue> = {}): GithubIssue {
  return {
    id: 7001,
    number: 5,
    title: "Widget breaks",
    body: "It broke.",
    user: ALICE,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

function makeReviewComment(overrides: Partial<GithubReviewComment> = {}): GithubReviewComment {
  return {
    id: 8001,
    body: "@acme-agent please rename this",
    user: ALICE,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    pull_request_url: "https://api.github.com/repos/octo/widgets/pulls/5",
    path: "src/widget.ts",
    line: 42,
    diff_hunk: "@@ -40,3 +40,3 @@\n-const a = 1;\n+const widgetCount = 1;",
    ...overrides,
  };
}

interface DeliveryOverrides {
  sender?: { login: string; type: string };
  repository?: { name: string; private: boolean; owner: { login: string } };
  issue?: Record<string, unknown>;
}

function issueFields(overrides: Record<string, unknown> = {}) {
  return {
    number: 5,
    title: "Widget breaks",
    body: "It broke.",
    user: ALICE,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function commentDelivery(
  body: string,
  overrides: DeliveryOverrides & { id?: number; action?: string } = {},
): GithubWebhookDelivery {
  const sender = overrides.sender ?? ALICE;
  return {
    event: "issue_comment",
    payload: {
      action: overrides.action ?? "created",
      repository: overrides.repository ?? REPOSITORY,
      sender,
      issue: issueFields(overrides.issue),
      comment: { id: overrides.id ?? 9001, body, user: sender, created_at: CREATED_AT },
    },
  };
}

function openedDelivery(
  body: string,
  overrides: DeliveryOverrides & { pullRequest?: boolean } = {},
): GithubWebhookDelivery {
  const item = issueFields({ body, ...overrides.issue });
  const common = {
    action: "opened",
    repository: overrides.repository ?? REPOSITORY,
    sender: overrides.sender ?? ALICE,
  };
  return overrides.pullRequest
    ? { event: "pull_request", payload: { ...common, pull_request: item } }
    : { event: "issues", payload: { ...common, issue: item } };
}

function assignedDelivery(
  assignee: string,
  overrides: DeliveryOverrides = {},
): GithubWebhookDelivery {
  return {
    event: "issues",
    payload: {
      action: "assigned",
      repository: overrides.repository ?? REPOSITORY,
      sender: overrides.sender ?? ALICE,
      issue: issueFields({ body: "Please handle this.", ...overrides.issue }),
      assignee: { login: assignee },
    },
  };
}

function reviewRequestedDelivery(reviewer: string): GithubWebhookDelivery {
  return {
    event: "pull_request",
    payload: {
      action: "review_requested",
      repository: REPOSITORY,
      sender: ALICE,
      pull_request: issueFields({ title: "Rename widget", body: "Renames it." }),
      requested_reviewer: { login: reviewer },
    },
  };
}

function reviewCommentDelivery(
  overrides: Partial<GithubReviewComment> = {},
  sender = ALICE,
): GithubWebhookDelivery {
  const comment = makeReviewComment({ user: sender, ...overrides });
  return {
    event: "pull_request_review_comment",
    payload: {
      action: "created",
      repository: REPOSITORY,
      sender,
      pull_request: issueFields(),
      comment: {
        id: comment.id,
        body: comment.body,
        user: comment.user,
        created_at: comment.created_at,
        path: comment.path,
        line: comment.line,
        diff_hunk: comment.diff_hunk,
        in_reply_to_id: comment.in_reply_to_id,
      },
    },
  };
}

type FakeClient = { [Method in keyof GithubApi]: Mock<GithubApi[Method]> };

function makeFakeClient(): FakeClient {
  return {
    getAuthenticatedUser: vi
      .fn<GithubApi["getAuthenticatedUser"]>()
      .mockResolvedValue({ login: "Acme-Agent", id: 999 }),
    listPullReviewComments: vi.fn<GithubApi["listPullReviewComments"]>().mockResolvedValue([]),
    listIssueComments: vi.fn<GithubApi["listIssueComments"]>().mockResolvedValue([]),
    createReviewCommentReaction: vi
      .fn<GithubApi["createReviewCommentReaction"]>()
      .mockResolvedValue(undefined),
    getIssue: vi.fn<GithubApi["getIssue"]>().mockResolvedValue(makeIssue()),
    createIssueComment: vi
      .fn<GithubApi["createIssueComment"]>()
      .mockResolvedValue(makeComment({ id: 555 })),
    updateIssueComment: vi.fn<GithubApi["updateIssueComment"]>().mockResolvedValue(undefined),
    deleteIssueComment: vi.fn<GithubApi["deleteIssueComment"]>().mockResolvedValue(undefined),
    createCommentReaction: vi.fn<GithubApi["createCommentReaction"]>().mockResolvedValue(undefined),
    createIssueReaction: vi.fn<GithubApi["createIssueReaction"]>().mockResolvedValue(undefined),
    getRepository: vi
      .fn<GithubApi["getRepository"]>()
      .mockResolvedValue({ default_branch: "main" }),
    getCollaboratorPermission: vi
      .fn<GithubApi["getCollaboratorPermission"]>()
      .mockResolvedValue({ permission: "write" }),
    createPullRequest: vi
      .fn<GithubApi["createPullRequest"]>()
      .mockResolvedValue({ number: 7, html_url: "https://github.com/octo/widgets/pull/7" }),
    getPullRequest: vi.fn<GithubApi["getPullRequest"]>().mockResolvedValue({
      number: 5,
      html_url: "https://github.com/octo/widgets/pull/5",
      head: { ref: "pi/fix-widget", sha: "headsha", repo: { full_name: "octo/widgets" } },
    }),
    findOpenPullRequestByBranch: vi
      .fn<GithubApi["findOpenPullRequestByBranch"]>()
      .mockResolvedValue(null),
    getCombinedStatus: vi
      .fn<GithubApi["getCombinedStatus"]>()
      .mockResolvedValue({ sha: "headsha", statuses: [] }),
    listWorkflowRuns: vi.fn<GithubApi["listWorkflowRuns"]>().mockResolvedValue([]),
    listWorkflowJobs: vi.fn<GithubApi["listWorkflowJobs"]>().mockResolvedValue([]),
    getJobLog: vi.fn<GithubApi["getJobLog"]>().mockResolvedValue(""),
    listPullRequestFiles: vi.fn<GithubApi["listPullRequestFiles"]>().mockResolvedValue([]),
    listIssues: vi.fn<GithubApi["listIssues"]>().mockResolvedValue([]),
    listPullRequestReviews: vi.fn<GithubApi["listPullRequestReviews"]>().mockResolvedValue([]),
    addIssueLabels: vi.fn<GithubApi["addIssueLabels"]>().mockResolvedValue(undefined),
    removeIssueLabel: vi.fn<GithubApi["removeIssueLabel"]>().mockResolvedValue(undefined),
    addIssueAssignees: vi.fn<GithubApi["addIssueAssignees"]>().mockResolvedValue(undefined),
    removeIssueAssignees: vi.fn<GithubApi["removeIssueAssignees"]>().mockResolvedValue(undefined),
    updateIssueState: vi.fn<GithubApi["updateIssueState"]>().mockResolvedValue(undefined),
    replyToReviewComment: vi
      .fn<GithubApi["replyToReviewComment"]>()
      .mockResolvedValue(makeReviewComment()),
  };
}

const CONVERSATION_ID = "GH_octo_widgets_5";
const CONVERSATION_OFFICE = officeKey(createOfficeAddress("github", CONVERSATION_ID));

async function settleQueues(): Promise<void> {
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
    for (const bad of ["C0123456789", "GH_octo_widgets", "GH_octo_widgets_x", "GH__widgets_1"]) {
      expect(() => parseGithubConversationId(bad)).toThrow(/Not a GitHub conversation id/);
    }
  });

  test("review-comment ts round-trips and other ts kinds parse to null", () => {
    expect(githubReviewCommentTs(8001)).toBe("rc-8001");
    expect(parseReviewCommentTs("rc-8001")).toBe(8001);
    expect(parseReviewCommentTs("8001")).toBeNull();
    expect(parseReviewCommentTs(GITHUB_ISSUE_BODY_TS)).toBeNull();
    expect(parseReviewCommentTs("rc-")).toBeNull();
    expect(parseReviewCommentTs("rc-8001x")).toBeNull();
  });
});

function makePolicy(overrides: Partial<GithubPolicy> = {}): GithubPolicy {
  return {
    repos: ["octo/widgets"],
    publicRepos: false,
    users: null,
    minPermission: "write",
    triggers: new Set(["mention", "assign", "review", "followup"]),
    capabilities: new Set(),
    ...overrides,
  };
}

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
    overrides: { handler?: MessagingEventHandler; policy?: Partial<GithubPolicy> } = {},
  ) {
    return new GithubMessagingBot(
      overrides.handler ?? handler,
      {
        token: AGENT_TOKEN,
        policy: makePolicy(overrides.policy),
        workspace: createWorkspace({ root: workingDir, stateDir: join(workingDir, "state") }),
      },
      client,
    );
  }

  async function startedBot(
    overrides: { handler?: MessagingEventHandler; policy?: Partial<GithubPolicy> } = {},
  ) {
    const bot = makeBot(overrides);
    await bot.start();
    return bot;
  }

  async function deliver(bot: GithubMessagingBot, ...deliveries: GithubWebhookDelivery[]) {
    for (const delivery of deliveries) await bot.receive(delivery);
    await settleQueues();
  }

  function participate(): void {
    mkdirSync(join(workingDir, CONVERSATION_OFFICE, "repo"), { recursive: true });
    writeFileSync(join(workingDir, CONVERSATION_OFFICE, "log.jsonl"), "{}\n");
  }

  test("start fails when the agent token is rejected", async () => {
    client.getAuthenticatedUser.mockRejectedValue(new Error("Bad credentials"));
    await expect(makeBot().start()).rejects.toThrow(/Bad credentials/);
  });

  test("deliveries before start or after stop are ignored", async () => {
    const bot = makeBot();
    await deliver(bot, commentDelivery("@acme-agent hi"));
    await bot.start();
    await bot.stop();
    await deliver(bot, commentDelivery("@acme-agent hi"));
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("a mentioned comment triggers a run with the mention stripped", async () => {
    const bot = await startedBot();
    await deliver(bot, commentDelivery("@acme-agent please fix this"));

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    const [event] = firstHandledEvent(handler);
    expect(event.address.conversationId).toBe(CONVERSATION_ID);
    expect(event.sessionKey).toBe(CONVERSATION_ID);
    expect(event.conversationKind).toBe("shared");
    expect(event.ts).toBe("9001");
    expect(event.user).toBe("alice");
    expect(event.text).toBe("please fix this");
  });

  test("a longer login that starts with the agent login is not a mention", async () => {
    const bot = await startedBot();
    await deliver(bot, commentDelivery("@acme-agent-two please fix this"));
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("repository casing does not change conversation identity", async () => {
    const bot = await startedBot();
    await deliver(
      bot,
      commentDelivery("@acme-agent hi", {
        repository: { name: "Widgets", private: true, owner: { login: "Octo" } },
      }),
    );
    const [event] = firstHandledEvent(handler);
    expect(event.address.conversationId).toBe(CONVERSATION_ID);
  });

  test("first contact via comment logs the issue body before the comment", async () => {
    const bot = await startedBot();
    await deliver(bot, commentDelivery("@acme-agent thoughts?"));

    const lines = readFileSync(join(workingDir, CONVERSATION_OFFICE, "log.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0].ts).toBe(GITHUB_ISSUE_BODY_TS);
    expect(lines[0].text).toContain("# Widget breaks");
    expect(Date.parse(lines[0].date)).toBe(Date.parse(CREATED_AT) - 1000);
    expect(lines[1].ts).toBe("9001");
    expect(lines[1].text).toBe("thoughts?");
  });

  test("an unmentioned comment in an unknown issue is ignored without creating state", async () => {
    const bot = await startedBot();
    await deliver(bot, commentDelivery("unrelated chatter"));

    expect(handler.handleEvent).not.toHaveBeenCalled();
    expect(client.getCollaboratorPermission).not.toHaveBeenCalled();
    expect(existsSync(join(workingDir, CONVERSATION_OFFICE))).toBe(false);
  });

  test("an unmentioned comment in a participating conversation triggers", async () => {
    participate();
    const bot = await startedBot();
    await deliver(bot, commentDelivery("follow-up question"));

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    expect(client.getIssue).not.toHaveBeenCalled();
  });

  test("bots and the agent account itself never trigger, even in a participating thread", async () => {
    participate();
    const bot = await startedBot();
    await deliver(
      bot,
      commentDelivery("@acme-agent hi", { sender: { login: "ci[bot]", type: "Bot" } }),
      commentDelivery("Here is my answer", { sender: { login: "acme-agent", type: "User" } }),
    );
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("edited and deleted comments do not trigger", async () => {
    const bot = await startedBot();
    await deliver(
      bot,
      commentDelivery("@acme-agent hi", { action: "edited" }),
      commentDelivery("@acme-agent hi", { action: "deleted" }),
    );
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("malformed and unrelated deliveries are ignored", async () => {
    const bot = await startedBot();
    await deliver(
      bot,
      { event: "issue_comment", payload: { action: "created" } },
      { event: "push", payload: {} },
    );
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("a newly opened issue mentioning the agent triggers with title and body", async () => {
    const bot = await startedBot();
    await deliver(bot, openedDelivery("@acme-agent can you triage this?"));

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    const [event] = firstHandledEvent(handler);
    expect(event.ts).toBe(GITHUB_ISSUE_BODY_TS);
    expect(event.text).toContain("# Widget breaks");
    expect(event.text).toContain("can you triage this?");
    expect(event.text).not.toContain("@acme-agent");
  });

  test("a mentioned 'stop' comment stops the running session instead of starting a run", async () => {
    const stopHandler = makeHandler([CONVERSATION_ID]);
    const bot = await startedBot({ handler: stopHandler });
    await deliver(bot, commentDelivery("@acme-agent stop"));

    expect(stopHandler.handleStop).toHaveBeenCalledWith(
      createOfficeAddress("github", CONVERSATION_ID),
      CONVERSATION_ID,
      bot,
    );
    expect(stopHandler.handleEvent).not.toHaveBeenCalled();
  });

  test("a first-contact 'stop' does not create participation state", async () => {
    const bot = await startedBot();
    await deliver(bot, commentDelivery("@acme-agent stop"));
    expect(existsSync(join(workingDir, CONVERSATION_OFFICE, "log.jsonl"))).toBe(false);

    await deliver(bot, commentDelivery("unrelated follow-up", { id: 991 }));
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("assigning the agent triggers a run on the issue as the assigner", async () => {
    const bot = await startedBot();
    await deliver(bot, assignedDelivery("Acme-Agent"));

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    const [event] = firstHandledEvent(handler);
    expect(event.address.conversationId).toBe(CONVERSATION_ID);
    expect(event.ts).toBe(GITHUB_ISSUE_BODY_TS);
    expect(event.user).toBe("alice");
    expect(event.text).toContain("[Assigned to you by @alice]");
    expect(event.text).toContain("# Widget breaks");
    expect(event.text).toContain("Please handle this.");
    expect(client.getIssue).not.toHaveBeenCalled();
  });

  test("assigning someone else does not trigger", async () => {
    const bot = await startedBot();
    await deliver(bot, assignedDelivery("bob"));
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("requesting the agent's review triggers on the pull request", async () => {
    const bot = await startedBot();
    await deliver(bot, reviewRequestedDelivery("acme-agent"), reviewRequestedDelivery("bob"));

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    const [event] = firstHandledEvent(handler);
    expect(event.text).toContain("[Review requested by @alice]");
    expect(event.text).toContain("# Rename widget");
    expect(cloneRepo).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 5, prHeadBranch: "pi/fix-widget" }),
    );
  });

  test("an issue opened with a mention and assigned to the agent triggers once", async () => {
    const bot = await startedBot();
    await deliver(
      bot,
      openedDelivery("@acme-agent please take this"),
      assignedDelivery("acme-agent"),
    );
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
  });

  describe("policy", () => {
    test("repositories outside GITHUB_REPOS are ignored", async () => {
      const bot = await startedBot();
      await deliver(
        bot,
        commentDelivery("@acme-agent hi", {
          repository: { name: "secrets", private: true, owner: { login: "octo" } },
        }),
      );
      expect(handler.handleEvent).not.toHaveBeenCalled();
      expect(client.getCollaboratorPermission).not.toHaveBeenCalled();
    });

    test("owner/* allows every repository of that owner", async () => {
      const bot = await startedBot({ policy: { repos: ["octo/*"] } });
      await deliver(
        bot,
        commentDelivery("@acme-agent hi", {
          repository: { name: "gears", private: true, owner: { login: "octo" } },
        }),
        commentDelivery("@acme-agent hi", {
          repository: { name: "gears", private: true, owner: { login: "other" } },
        }),
      );
      expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    });

    test("public repositories need GITHUB_PUBLIC_REPOS", async () => {
      const publicRepo = { ...REPOSITORY, private: false };
      const closed = await startedBot();
      await deliver(closed, commentDelivery("@acme-agent hi", { repository: publicRepo }));
      expect(handler.handleEvent).not.toHaveBeenCalled();

      const open = await startedBot({ policy: { publicRepos: true } });
      await deliver(open, commentDelivery("@acme-agent hi", { repository: publicRepo }));
      expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    });

    test("GITHUB_USERS limits who can trigger", async () => {
      const bot = await startedBot({ policy: { users: ["bob"] } });
      await deliver(bot, commentDelivery("@acme-agent hi"));
      expect(handler.handleEvent).not.toHaveBeenCalled();

      await deliver(
        bot,
        commentDelivery("@acme-agent hi", { id: 2, sender: { login: "Bob", type: "User" } }),
      );
      expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    });

    test("disabled triggers are ignored", async () => {
      participate();
      const bot = await startedBot({ policy: { triggers: new Set(["mention"]) } });
      await deliver(bot, commentDelivery("follow-up"), assignedDelivery("acme-agent"));
      expect(handler.handleEvent).not.toHaveBeenCalled();

      await deliver(bot, commentDelivery("@acme-agent now", { id: 2 }));
      expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    });

    test("senders below the minimum permission are ignored entirely", async () => {
      const bot = await startedBot({ policy: { minPermission: "maintain" } });
      await deliver(bot, commentDelivery("@acme-agent do things"));

      expect(client.getCollaboratorPermission).toHaveBeenCalledWith("octo", "widgets", "alice");
      expect(handler.handleEvent).not.toHaveBeenCalled();
      expect(existsSync(join(workingDir, CONVERSATION_OFFICE))).toBe(false);
    });

    test("custom roles fall back to the stronger legacy permission field", async () => {
      client.getCollaboratorPermission.mockResolvedValue({
        permission: "write",
        role_name: "custom-deployer",
      });
      const bot = await startedBot();
      await deliver(bot, commentDelivery("@acme-agent hi"));
      expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    });

    test("permission lookups are cached per repo and user", async () => {
      const bot = await startedBot();
      await deliver(
        bot,
        commentDelivery("@acme-agent one", { id: 1 }),
        commentDelivery("@acme-agent two", { id: 2 }),
      );
      expect(handler.handleEvent).toHaveBeenCalledTimes(2);
      expect(client.getCollaboratorPermission).toHaveBeenCalledTimes(1);
    });

    test("a failed permission lookup denies the trigger", async () => {
      client.getCollaboratorPermission.mockRejectedValue(new Error("boom"));
      const bot = await startedBot();
      await deliver(bot, commentDelivery("@acme-agent hi"));
      expect(handler.handleEvent).not.toHaveBeenCalled();
    });
  });

  test("first contact clones with the agent token as the agent's commit identity", async () => {
    const bot = await startedBot();
    await deliver(bot, commentDelivery("@acme-agent look"));

    expect(cloneRepo).toHaveBeenCalledWith({
      url: "https://github.com/octo/widgets.git",
      dir: join(workingDir, CONVERSATION_OFFICE, "repo"),
      token: AGENT_TOKEN,
      authorName: "Acme-Agent",
      authorEmail: "999+Acme-Agent@users.noreply.github.com",
      prNumber: undefined,
      prHeadBranch: undefined,
    });
  });

  test("a pull request opened with a mention checks out its head branch", async () => {
    const bot = await startedBot();
    await deliver(bot, openedDelivery("@acme-agent review this", { pullRequest: true }));

    expect(cloneRepo).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 5, prHeadBranch: "pi/fix-widget" }),
    );
  });

  test("fork PRs clone without a head branch name", async () => {
    client.getPullRequest.mockResolvedValue({
      number: 5,
      html_url: "https://github.com/octo/widgets/pull/5",
      head: { ref: "feature", sha: "headsha", repo: { full_name: "alice/widgets" } },
    });
    const bot = await startedBot();
    await deliver(bot, openedDelivery("@acme-agent review this", { pullRequest: true }));

    expect(cloneRepo).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 5, prHeadBranch: undefined }),
    );
  });

  test("ignored comments never clone", async () => {
    const bot = await startedBot();
    await deliver(bot, commentDelivery("unrelated"));
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  test("an existing clone is not cloned again", async () => {
    mkdirSync(join(workingDir, CONVERSATION_OFFICE, "repo"), { recursive: true });
    const bot = await startedBot();
    await deliver(bot, commentDelivery("@acme-agent again"));
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  test("a participating conversation with a missing clone retries on the next trigger", async () => {
    mkdirSync(join(workingDir, CONVERSATION_OFFICE), { recursive: true });
    writeFileSync(join(workingDir, CONVERSATION_OFFICE, "log.jsonl"), "{}\n");
    const bot = await startedBot();
    await deliver(bot, commentDelivery("try again", { issue: { pull_request: {} } }));

    expect(cloneRepo).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 5 }));
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
  });

  test("a mentioned review comment triggers with diff anchor context and rc- ts", async () => {
    const bot = await startedBot();
    await deliver(bot, reviewCommentDelivery());

    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
    const [event] = firstHandledEvent(handler);
    expect(event.address.conversationId).toBe(CONVERSATION_ID);
    expect(event.ts).toBe("rc-8001");
    expect(event.text).toContain("[PR review comment rc-8001 on src/widget.ts:42]");
    expect(event.text).toContain("```diff");
    expect(event.text).toContain("+const widgetCount = 1;");
    expect(event.text).toContain("please rename this");
    expect(event.text).not.toContain("@acme-agent");
    expect(cloneRepo).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 5 }));
    expect(client.listPullReviewComments).not.toHaveBeenCalled();
  });

  test("a mid-thread review reply carries the thread's earlier turns", async () => {
    client.listPullReviewComments.mockResolvedValue([
      makeReviewComment({
        id: 7000,
        body: "root: why this name?",
        user: { login: "bob", type: "User" },
      }),
      makeReviewComment({ id: 7500, body: "because clarity", in_reply_to_id: 7000 }),
      makeReviewComment({ id: 8001, body: "@acme-agent settle this", in_reply_to_id: 7000 }),
    ]);
    const bot = await startedBot();
    await deliver(
      bot,
      reviewCommentDelivery({ id: 8001, body: "@acme-agent settle this", in_reply_to_id: 7000 }),
    );

    const [event] = firstHandledEvent(handler);
    expect(event.text).toContain("Thread so far:");
    expect(event.text).toContain("@bob: root: why this name?");
    expect(event.text).toContain("@alice: because clarity");
    expect(event.text.indexOf("settle this")).toBe(event.text.lastIndexOf("settle this"));
  });

  test("postMessage posts a comment and returns its id", async () => {
    const bot = await startedBot();
    expect(await bot.postMessage(CONVERSATION_ID, "hello")).toBe("555");
    expect(client.createIssueComment).toHaveBeenCalledWith("octo", "widgets", 5, "hello");
  });

  test("addReaction maps short names and routes issue-body, comment, and review comment", async () => {
    const bot = await startedBot();

    await bot.addReaction(CONVERSATION_ID, "9001", "saluting_face");
    expect(client.createCommentReaction).toHaveBeenCalledWith("octo", "widgets", 9001, "eyes");

    await bot.addReaction(CONVERSATION_ID, GITHUB_ISSUE_BODY_TS, "tada");
    expect(client.createIssueReaction).toHaveBeenCalledWith("octo", "widgets", 5, "hooray");

    await bot.addReaction(CONVERSATION_ID, "rc-8001", "eyes");
    expect(client.createReviewCommentReaction).toHaveBeenCalledWith(
      "octo",
      "widgets",
      8001,
      "eyes",
    );

    await expect(bot.addReaction(CONVERSATION_ID, "9001", "sparkles")).rejects.toThrow(
      /does not support reaction/,
    );
  });

  test("pushAndCreatePr pushes the branch with the agent token and opens the PR", async () => {
    mkdirSync(join(workingDir, CONVERSATION_OFFICE, "repo"), { recursive: true });
    const bot = await startedBot();

    const result = await bot.ops.pushAndCreatePr(CONVERSATION_ID, {
      branch: "pi/fix-5",
      title: "Fix the widget",
      body: "Closes #5",
      draft: true,
    });

    expect(pushBranch).toHaveBeenCalledWith({
      dir: join(workingDir, CONVERSATION_OFFICE, "repo"),
      branch: "pi/fix-5",
      token: AGENT_TOKEN,
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
    const { GithubApiError } = await import("../adapters/github/client.js");
    client.createPullRequest.mockRejectedValue(
      new GithubApiError(422, "POST", "/repos/octo/widgets/pulls", "A pull request already exists"),
    );
    client.findOpenPullRequestByBranch = vi.fn().mockResolvedValue({
      number: 7,
      html_url: "https://github.com/octo/widgets/pull/7",
    });
    const bot = await startedBot();

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

  test("getChecks merges Actions jobs and commit statuses for a branch or the PR head", async () => {
    client.getCombinedStatus.mockResolvedValue({
      sha: "abc123",
      statuses: [
        {
          id: 3,
          context: "ci/external",
          state: "failure",
          description: "2 tests failed",
          target_url: "https://ci.example.com/3",
        },
        { id: 4, context: "lint", state: "pending", description: null, target_url: null },
      ],
    });
    client.listWorkflowRuns.mockResolvedValue([{ id: 10, name: "CI" }]);
    client.listWorkflowJobs.mockResolvedValue([
      {
        id: 42,
        name: "test",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/octo/widgets/actions/runs/10/job/42",
      },
    ]);
    const bot = await startedBot();

    expect(await bot.ops.getChecks(CONVERSATION_ID, "pi/fix-5")).toEqual([
      {
        id: 42,
        name: "CI / test",
        status: "completed",
        conclusion: "success",
        url: "https://github.com/octo/widgets/actions/runs/10/job/42",
        source: "actions",
        outputSummary: null,
      },
      {
        id: 3,
        name: "ci/external",
        status: "completed",
        conclusion: "failure",
        url: "https://ci.example.com/3",
        source: "status",
        outputSummary: "2 tests failed",
      },
      {
        id: 4,
        name: "lint",
        status: "in_progress",
        conclusion: null,
        url: null,
        source: "status",
        outputSummary: null,
      },
    ]);
    expect(client.getCombinedStatus).toHaveBeenLastCalledWith("octo", "widgets", "pi/fix-5");
    expect(client.listWorkflowRuns).toHaveBeenLastCalledWith("octo", "widgets", "abc123");
    expect(client.listWorkflowJobs).toHaveBeenLastCalledWith("octo", "widgets", 10);

    await bot.ops.getChecks(CONVERSATION_ID);
    expect(client.getCombinedStatus).toHaveBeenLastCalledWith("octo", "widgets", "headsha");
  });

  test("getJobLog truncates to the tail of huge logs", async () => {
    client.getJobLog = vi.fn().mockResolvedValue(`${"x".repeat(30000)}TAIL`);
    const bot = await startedBot();

    const logText = await bot.ops.getJobLog(CONVERSATION_ID, 42);
    expect(client.getJobLog).toHaveBeenCalledWith("octo", "widgets", 42);
    expect(logText).toContain("truncated to the last 20000 chars");
    expect(logText.endsWith("TAIL")).toBe(true);
    expect(logText.length).toBeLessThan(21000);
  });

  test("getJobLog rejects invalid ids and translates 404 into guidance", async () => {
    const { GithubApiError } = await import("../adapters/github/client.js");
    client.getJobLog = vi
      .fn()
      .mockRejectedValue(
        new GithubApiError(404, "GET", "/repos/octo/widgets/actions/jobs/9/logs", "Not Found"),
      );
    const bot = await startedBot();

    await expect(bot.ops.getJobLog(CONVERSATION_ID, 0)).rejects.toThrow(/positive Actions job id/);
    expect(client.getJobLog).not.toHaveBeenCalled();
    await expect(bot.ops.getJobLog(CONVERSATION_ID, 9)).rejects.toThrow(/Do not retry/);
  });

  test("getChecks without a branch demands one when the conversation is a plain issue", async () => {
    client.getPullRequest = vi.fn().mockRejectedValue(new Error("404"));
    const bot = await startedBot();
    await expect(bot.ops.getChecks(CONVERSATION_ID)).rejects.toThrow(/pass the branch/);
  });

  test("syncRepo requires a clone and fetches the PR head with the agent token", async () => {
    const bot = await startedBot();

    await expect(bot.ops.syncRepo(CONVERSATION_ID)).rejects.toThrow(/no \.\/repo clone/);

    mkdirSync(join(workingDir, CONVERSATION_OFFICE, "repo"), { recursive: true });
    client.getIssue.mockResolvedValue(makeIssue({ pull_request: {} }));

    const report = await bot.ops.syncRepo(CONVERSATION_ID);

    expect(syncRepo).toHaveBeenCalledWith({
      dir: join(workingDir, CONVERSATION_OFFICE, "repo"),
      token: AGENT_TOKEN,
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
    vi.mocked(syncRepo).mockResolvedValueOnce({
      target: "main",
      fetchedSha: "abc123def4567890",
      updatedCheckout: false,
      dirty: true,
      currentBranch: "main",
      localCommits: 2,
    });
    const bot = await startedBot();

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
    const bot = await startedBot();

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
    const bot = await startedBot();

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
    const bot = await startedBot();

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
    const { GithubApiError } = await import("../adapters/github/client.js");
    client.addIssueLabels = vi.fn().mockResolvedValue(undefined);
    client.updateIssueState = vi
      .fn()
      .mockRejectedValue(new GithubApiError(404, "PATCH", "/x", "Not Found"));
    const bot = await startedBot();

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
    const bot = await startedBot();

    const result = await bot.ops.replyToReviewThread(CONVERSATION_ID, 8001, "done");

    expect(client.replyToReviewComment).toHaveBeenCalledWith("octo", "widgets", 5, 8001, "done");
    expect(result.url).toBe("https://github.com/octo/widgets/pull/5#discussion_r9002");
  });

  test("replyToReviewThread rejects bad ids and translates 404 into guidance", async () => {
    const { GithubApiError } = await import("../adapters/github/client.js");
    client.replyToReviewComment = vi
      .fn()
      .mockRejectedValue(new GithubApiError(404, "POST", "/x", "Not Found"));
    const bot = await startedBot();

    await expect(bot.ops.replyToReviewThread(CONVERSATION_ID, 0, "x")).rejects.toThrow(
      /numeric id from an \[PR review comment/,
    );
    expect(client.replyToReviewComment).not.toHaveBeenCalled();
    await expect(bot.ops.replyToReviewThread(CONVERSATION_ID, 123, "x")).rejects.toThrow(
      /not a review comment on this PR/,
    );
  });

  test("addReaction shows the work acknowledgement as eyes, GitHub's closest reaction", async () => {
    const bot = await startedBot();
    await bot.addReaction(CONVERSATION_ID, "9001", "saluting_face");
    expect(client.createCommentReaction).toHaveBeenCalledWith("octo", "widgets", 9001, "eyes");
  });

  test("addReaction routes rc- ts to the review-comment reactions endpoint", async () => {
    const bot = await startedBot();

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
    const bot = await startedBot();

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
