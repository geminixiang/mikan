import type { ConversationMessage, ConversationResponder, MessagingInfo } from "../../adapter.js";
import { resolveChatSessionKey } from "../../sessions/policy.js";
import { createProgressiveRenderer, formatMarkdownToolResult } from "../progressive-renderer.js";
import { createChatResponseErrorReporter } from "../shared.js";
import { formatGithubContinuation, type GithubMessagingBot } from "./bot.js";
import { GITHUB_MAX_COMMENT_LENGTH } from "./client.js";
import { parseGithubConversationId } from "./ids.js";
import type { GithubEvent } from "./types.js";

export function createGithubAdapters(
  event: GithubEvent,
  bot: GithubMessagingBot,
): {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
} {
  const conversationId = event.conversationId;
  const ref = parseGithubConversationId(conversationId);

  const message: ConversationMessage = {
    id: event.ts,
    sessionKey:
      event.sessionKey ??
      resolveChatSessionKey({
        conversationId,
        conversationKind: event.conversationKind,
        messageId: event.ts,
        persistentTopLevel: true,
        threadTs: event.thread_ts,
      }),
    conversationKind: event.conversationKind,
    userId: event.user,
    userName: event.userName,
    text: event.text,
    attachments: event.attachments,
    threadTs: event.thread_ts,
  };

  // The bot's getMessagingInfo() is the single authority for platform info;
  // the conversation-scoped context below is an explicit append, not a fork.
  const baseInfo = bot.getMessagingInfo();
  const platform: MessagingInfo = {
    ...baseInfo,
    formattingGuide:
      `${baseInfo.formattingGuide}\n\n` +
      `## Conversation context\n` +
      `This conversation IS GitHub issue/PR ${ref.owner}/${ref.repo}#${ref.number}: the ` +
      `first message in the history is its title and body, and the following messages are ` +
      `its comments. When the user says "this issue", they mean #${ref.number}. Messages ` +
      `tagged [PR review comment rc-<id> …] are inline review threads on a diff line: ` +
      `answer those with the github_review_reply tool (comment_id = that id) so the reply ` +
      `lands in-thread — your normal response posts as a plain PR comment.\n\n` +
      `## Repository & pull requests\n` +
      `The repository is cloned at ./repo — a snapshot from this conversation's first ` +
      `trigger; run github_sync when it may be stale to pull the latest PR head or base ` +
      `branch. If this conversation is a pull request, its head branch is checked out ` +
      `under its real name (run git branch --show-current in ./repo to see it; fork PRs ` +
      `fall back to pr-${ref.number}). You have no git credentials, so git fetch/push ` +
      `fail by design.\n` +
      `To ship code changes: commit inside ./repo (the git author is preconfigured) on a ` +
      `pi/<name> branch, then call the github_pr tool to push it. When this conversation's ` +
      `checked-out PR head branch is already named pi/<name> — e.g. a PR you opened ` +
      `earlier — commit directly on it and pass that branch to github_pr: the push ` +
      `updates THIS pull request instead of opening a new one. Any other branch opens a ` +
      `new pull request (draft: true for a draft); calling github_pr again with the same ` +
      `branch pushes new commits to its existing PR. Use github_checks to read CI results ` +
      `for your branch (or this PR) — pass a failing check's job id to read its log — and ` +
      `iterate until they pass. You cannot push the default branch or ` +
      `merge — humans review and merge every PR.\n` +
      `github_read looks up PR/issue metadata this clone cannot show (diff stats, changed ` +
      `files, review state, other issues in this repo); github_issue manages labels, ` +
      `assignees, and close/reopen for triage.`,
    diagnostics: {
      showUsageSummary: false,
    },
  };

  // streaming: false — GitHub gets the finished response in one comment.
  // Streaming would edit the comment on every flush: API churn and "edited"
  // noise for readers who refresh rather than watch typing. There is also no
  // typing indicator or working suffix; progress shows through comment edits.
  const { responder } = createProgressiveRenderer({
    label: "GitHub",
    maxLength: GITHUB_MAX_COMMENT_LENGTH,
    formatContinuation: formatGithubContinuation,
    errorPrefix: "**Error:** ",
    formatToolResult: formatMarkdownToolResult,
    reportError: (err, operation, extra, responseId) =>
      createChatResponseErrorReporter(() => ({
        platform: "github",
        conversationId,
        messageId: message.id,
        sessionKey: message.sessionKey,
        responseMessageId: responseId === null ? null : Number(responseId),
        conversationKind: message.conversationKind,
      }))(err, operation, extra),
    post: async (text) => {
      return String(await bot.postComment(ref, text));
    },
    update: (id, text) => bot.updateMessage(conversationId, id, text),
    postExtra: async (text) => bot.postComment(ref, text),
    delete: async (id) => {
      await bot.deleteComment(ref, Number(id));
    },
    logBotResponse: (text, id) => bot.logBotResponse(conversationId, text, id),
    // The REST API cannot attach files to comments (uploads are a browser
    // feature); leave a pointer instead of failing the run.
    uploadFallbackNote: (name) =>
      `*(file \`${name}\` was produced, but the GitHub adapter cannot attach files to comments)*`,
    react: (emoji) => bot.addReaction(conversationId, event.ts, emoji),
  });

  return { message, responder, platform };
}
