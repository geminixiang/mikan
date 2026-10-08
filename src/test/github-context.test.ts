import { describe, expect, test, vi } from "vitest";
import { GithubMessagingBot } from "../adapters/github/bot.js";
import { GITHUB_MAX_COMMENT_LENGTH } from "../adapters/github/client.js";
import { createGithubAdapters } from "../adapters/github/context.js";
import type {
  GithubCapability,
  GithubConversationBot,
  GithubEvent,
} from "../adapters/github/types.js";
import { createOfficeAddress } from "../office/index.js";

function makeEvent(overrides: Partial<GithubEvent> = {}): GithubEvent {
  return {
    type: "message",
    address: createOfficeAddress("github", "GH_octo_widgets_5"),
    conversationKind: "shared",
    ts: "9001",
    user: "alice",
    userName: "alice",
    text: "please fix",
    ...overrides,
  };
}

function makeFakeBot(capabilities: ReadonlySet<GithubCapability> = new Set()) {
  return {
    capabilities,
    agentIdentity: { login: "acme-agent", email: "999+acme-agent@users.noreply.github.com" },
    postComment: vi.fn<GithubConversationBot["postComment"]>().mockResolvedValue(555),
    updateMessage: vi.fn<GithubConversationBot["updateMessage"]>().mockResolvedValue(undefined),
    deleteComment: vi.fn<GithubConversationBot["deleteComment"]>().mockResolvedValue(undefined),
    addReaction: vi.fn<GithubConversationBot["addReaction"]>().mockResolvedValue(undefined),
    logBotResponse: vi.fn<GithubConversationBot["logBotResponse"]>(),
    getMessagingInfo: GithubMessagingBot.prototype.getMessagingInfo,
  } satisfies GithubConversationBot;
}

describe("createGithubAdapters", () => {
  test("the guide offers pushing and triage only when those capabilities are enabled", () => {
    const readOnly = createGithubAdapters(makeEvent(), makeFakeBot()).platform.formattingGuide;
    expect(readOnly).toContain("Do not push branches or open pull requests here");
    expect(readOnly).not.toContain("github_pr");
    expect(readOnly).not.toContain("github_issue");

    const full = createGithubAdapters(makeEvent(), makeFakeBot(new Set(["push", "triage"])))
      .platform.formattingGuide;
    expect(full).toContain("then call github_pr");
    expect(full).toContain("github_issue manages labels");
  });

  test("session key is the conversation id (one issue = one session)", () => {
    const { message } = createGithubAdapters(makeEvent(), makeFakeBot());
    expect(message.sessionKey).toBe("GH_octo_widgets_5");
    expect(message.conversationKind).toBe("shared");
  });

  test("respond posts one comment then edits it on subsequent responds", async () => {
    const bot = makeFakeBot();
    const { responder } = createGithubAdapters(makeEvent(), bot);

    await responder.respond("first");
    expect(bot.postComment).toHaveBeenCalledWith(
      { owner: "octo", repo: "widgets", number: 5 },
      "first",
    );

    await responder.respond("second");
    expect(bot.updateMessage).toHaveBeenCalledWith("GH_octo_widgets_5", "555", "first\nsecond");
    expect(bot.postComment).toHaveBeenCalledTimes(1);
  });

  test("long responses split into comments and replacement reuses their ids in order", async () => {
    const bot = makeFakeBot();
    bot.postComment.mockResolvedValueOnce(555).mockResolvedValueOnce(556);
    const { responder } = createGithubAdapters(makeEvent(), bot);
    const answer = "A".repeat(GITHUB_MAX_COMMENT_LENGTH) + "B".repeat(100);

    await responder.respond(answer);

    expect(bot.postComment).toHaveBeenCalledTimes(2);
    expect(bot.updateMessage).not.toHaveBeenCalled();
    const parts = bot.postComment.mock.calls.map(([ref, text]) => {
      expect(ref).toEqual({ owner: "octo", repo: "widgets", number: 5 });
      expect(text.length).toBeLessThanOrEqual(GITHUB_MAX_COMMENT_LENGTH);
      return text;
    });
    const [first, second] = parts;
    if (first === undefined || second === undefined) throw new Error("expected two comment parts");
    expect(first).toMatch(/\n\*\(continued 1\)\*$/);
    expect(first.replace(/\n\*\(continued 1\)\*$/, "") + second).toBe(answer);

    await responder.replaceResponse(answer.replaceAll("A", "C").replaceAll("B", "D"), {
      final: true,
    });

    expect(bot.postComment).toHaveBeenCalledTimes(2);
    expect(bot.updateMessage.mock.calls).toEqual([
      ["GH_octo_widgets_5", "555", first.replaceAll("A", "C").replaceAll("B", "D")],
      ["GH_octo_widgets_5", "556", second.replaceAll("A", "C").replaceAll("B", "D")],
    ]);
  });

  test("an answer is not shown while it is written, only its tool progress and final text", () => {
    const { responder } = createGithubAdapters(makeEvent(), makeFakeBot());
    expect(responder.showsPartialAnswer).toBe(false);
  });

  test("system prompt context names the issue the conversation lives in", () => {
    const { platform } = createGithubAdapters(makeEvent(), makeFakeBot());
    expect(platform.formattingGuide).toContain("octo/widgets#5");
    expect(platform.formattingGuide).toContain("first message");
  });

  test("system prompt has the agent clone and push inside its sandbox as the agent account", () => {
    const { platform } = createGithubAdapters(makeEvent(), makeFakeBot(new Set(["push"])));
    const guide = platform.formattingGuide;
    expect(guide).toContain("git clone https://github.com/octo/widgets.git");
    expect(guide).toContain("gh pr checkout 5");
    expect(guide).toContain('user.email "999+acme-agent@users.noreply.github.com"');
    expect(guide).toContain("github_pr");
    expect(guide).not.toContain("./repo");
    expect(guide).not.toContain("github_sync");
  });

  test("the platform trusts membership", () => {
    expect(createGithubAdapters(makeEvent(), makeFakeBot()).platform.trustModel).toBe("membership");
  });

  test("respondDiagnostic posts a separate comment and keeps the response intact", async () => {
    const bot = makeFakeBot();
    const { responder } = createGithubAdapters(makeEvent(), bot);

    await responder.respond("answer");
    await responder.respondDiagnostic("something failed", { style: "error" });

    expect(bot.postComment).toHaveBeenCalledTimes(2);
    expect(bot.postComment).toHaveBeenLastCalledWith(
      { owner: "octo", repo: "widgets", number: 5 },
      "**Error:** something failed",
    );
    expect(bot.updateMessage).not.toHaveBeenCalled();
  });

  test("uploadFile leaves a pointer comment instead of failing", async () => {
    const bot = makeFakeBot();
    const { responder } = createGithubAdapters(makeEvent(), bot);

    await responder.uploadFile("/tmp/report.pdf", "report.pdf");
    expect(bot.postComment).toHaveBeenCalledWith(
      { owner: "octo", repo: "widgets", number: 5 },
      expect.stringContaining("report.pdf"),
    );
  });

  test("react targets the triggering message", async () => {
    const bot = makeFakeBot();
    const { responder } = createGithubAdapters(makeEvent(), bot);
    await responder.react!("eyes");
    expect(bot.addReaction).toHaveBeenCalledWith("GH_octo_widgets_5", "9001", "eyes");
  });

  test("deleteResponse removes the posted comment", async () => {
    const bot = makeFakeBot();
    const { responder } = createGithubAdapters(makeEvent(), bot);
    await responder.respond("oops");
    await responder.deleteResponse();
    expect(bot.deleteComment).toHaveBeenCalledWith(
      { owner: "octo", repo: "widgets", number: 5 },
      555,
    );
  });
});
