import { describe, expect, test, vi } from "vitest";
import { GithubMessagingBot } from "../adapters/github/bot.js";
import { GITHUB_MAX_COMMENT_LENGTH } from "../adapters/github/client.js";
import { createGithubAdapters } from "../adapters/github/context.js";
import type { GithubEvent } from "../adapters/github/types.js";

function makeEvent(overrides: Partial<GithubEvent> = {}): GithubEvent {
  return {
    type: "message",
    conversationId: "GH_octo_widgets_5",
    conversationKind: "shared",
    ts: "9001",
    user: "alice",
    userName: "alice",
    text: "please fix",
    ...overrides,
  };
}

function makeFakeBot() {
  return {
    postComment: vi.fn().mockResolvedValue(555),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteComment: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    logBotResponse: vi.fn(),
    getMessagingInfo: GithubMessagingBot.prototype.getMessagingInfo,
  };
}

describe("createGithubAdapters", () => {
  test("session key is the conversation id (one issue = one session)", () => {
    const { message } = createGithubAdapters(
      makeEvent(),
      makeFakeBot() as unknown as GithubMessagingBot,
    );
    expect(message.sessionKey).toBe("GH_octo_widgets_5");
    expect(message.conversationKind).toBe("shared");
  });

  test("respond posts one comment then edits it on subsequent responds", async () => {
    const bot = makeFakeBot();
    const { responder } = createGithubAdapters(makeEvent(), bot as unknown as GithubMessagingBot);

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
    const { responder } = createGithubAdapters(makeEvent(), bot as unknown as GithubMessagingBot);
    const answer = "A".repeat(GITHUB_MAX_COMMENT_LENGTH) + "B".repeat(100);

    await responder.respond(answer);

    expect(bot.postComment).toHaveBeenCalledTimes(2);
    expect(bot.updateMessage).not.toHaveBeenCalled();
    const parts = bot.postComment.mock.calls.map(([ref, text]) => {
      expect(ref).toEqual({ owner: "octo", repo: "widgets", number: 5 });
      expect(text.length).toBeLessThanOrEqual(GITHUB_MAX_COMMENT_LENGTH);
      return text as string;
    });
    expect(parts[0]).toMatch(/\n\*\(continued 1\)\*$/);
    expect(parts[0].replace(/\n\*\(continued 1\)\*$/, "") + parts[1]).toBe(answer);

    await responder.replaceResponse(answer.replaceAll("A", "C").replaceAll("B", "D"));

    expect(bot.postComment).toHaveBeenCalledTimes(2);
    expect(bot.updateMessage.mock.calls).toEqual([
      ["GH_octo_widgets_5", "555", parts[0].replaceAll("A", "C").replaceAll("B", "D")],
      ["GH_octo_widgets_5", "556", parts[1].replaceAll("A", "C").replaceAll("B", "D")],
    ]);
  });

  test("streaming is disabled so the runner falls back to a single respond()", () => {
    const { responder } = createGithubAdapters(
      makeEvent(),
      makeFakeBot() as unknown as GithubMessagingBot,
    );
    expect(responder.appendResponseDelta).toBeUndefined();
    expect(responder.finishResponse).toBeUndefined();
  });

  test("system prompt context names the issue the conversation lives in", () => {
    const { platform } = createGithubAdapters(
      makeEvent(),
      makeFakeBot() as unknown as GithubMessagingBot,
    );
    expect(platform.formattingGuide).toContain("octo/widgets#5");
    expect(platform.formattingGuide).toContain("first message");
  });

  test("system prompt explains the repo clone and github_pr workflow", () => {
    const { platform } = createGithubAdapters(
      makeEvent(),
      makeFakeBot() as unknown as GithubMessagingBot,
    );
    expect(platform.formattingGuide).toContain("./repo");
    expect(platform.formattingGuide).toContain("github_pr");
    expect(platform.formattingGuide).toContain("pi/<name>");
  });

  test("respondDiagnostic posts a separate comment and keeps the response intact", async () => {
    const bot = makeFakeBot();
    const { responder } = createGithubAdapters(makeEvent(), bot as unknown as GithubMessagingBot);

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
    const { responder } = createGithubAdapters(makeEvent(), bot as unknown as GithubMessagingBot);

    await responder.uploadFile("/tmp/report.pdf", "report.pdf");
    expect(bot.postComment).toHaveBeenCalledWith(
      { owner: "octo", repo: "widgets", number: 5 },
      expect.stringContaining("report.pdf"),
    );
  });

  test("react targets the triggering message", async () => {
    const bot = makeFakeBot();
    const { responder } = createGithubAdapters(makeEvent(), bot as unknown as GithubMessagingBot);
    await responder.react!("eyes");
    expect(bot.addReaction).toHaveBeenCalledWith("GH_octo_widgets_5", "9001", "eyes");
  });

  test("deleteResponse removes the posted comment", async () => {
    const bot = makeFakeBot();
    const { responder } = createGithubAdapters(makeEvent(), bot as unknown as GithubMessagingBot);
    await responder.respond("oops");
    await responder.deleteResponse();
    expect(bot.deleteComment).toHaveBeenCalledWith(
      { owner: "octo", repo: "widgets", number: 5 },
      555,
    );
  });
});
