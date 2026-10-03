import type { ConversationContext } from "../../types.js";
import { createConversationMessage, parseGithubConversationId } from "../../office/index.js";
import { resolveChatSessionKey } from "../../sessions/session-key.js";
import { createProgressiveRenderer, formatMarkdownToolResult } from "../progressive-renderer.js";
import { formatGithubContinuation } from "./bot.js";
import { GITHUB_MAX_COMMENT_LENGTH } from "./client.js";
import type {
  GithubCapability,
  GithubAgentIdentity,
  GithubConversationBot,
  GithubEvent,
} from "./types.js";
import type { GithubConversationRef } from "../../office/types.js";

function repositoryGuide(
  capabilities: ReadonlySet<GithubCapability>,
  ref: GithubConversationRef,
  identity: GithubAgentIdentity | undefined,
): string {
  const author = identity
    ? `Commit as the agent account: git config user.name "${identity.login}" and ` +
      `git config user.email "${identity.email}". `
    : "";
  const clone =
    `## Repository & pull requests\n` +
    `Nothing is cloned for you. When you need the code, clone it into your scratch ` +
    `directory with git clone https://github.com/${ref.owner}/${ref.repo}.git; if this ` +
    `conversation is a pull request, run gh pr checkout ${ref.number} inside the clone. ` +
    `git and gh use the GitHub credentials of this sandbox, if it has any; without them ` +
    `only public repositories are reachable. ${author}\n`;
  const shipping = capabilities.has("push")
    ? `To ship code changes: push a new branch (for example pi/fix-${ref.number}), never ` +
      `the default branch, which is protected, then call github_pr with that branch to ` +
      `open a pull request (draft: true for a draft). To update this pull request, push ` +
      `to its head branch; no github_pr call is needed. Use github_checks to read CI ` +
      `results for your branch (or this PR) — pass a failing check's job id to read its ` +
      `log — and iterate until they pass. Humans review and merge every PR.\n`
    : `Do not push branches or open pull requests here: propose code changes in your ` +
      `reply (for example as a diff or suggestion block) for a human to apply. Use ` +
      `github_checks to read this pull request's CI results.\n`;
  const lookup =
    `github_read looks up PR/issue metadata that a clone does not show (diff stats, ` +
    `changed files, review state, other issues in this repo)` +
    (capabilities.has("triage")
      ? `; github_issue manages labels, assignees, and close/reopen for triage.`
      : `.`);
  return clone + shipping + lookup;
}

export function createGithubAdapters(
  event: GithubEvent,
  bot: GithubConversationBot,
): ConversationContext {
  const conversationId = event.address.conversationId;
  const ref = parseGithubConversationId(conversationId);

  const message = createConversationMessage({
    platform: "github",
    conversationId,
    address: event.address,
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
  });
  const baseInfo = bot.getMessagingInfo();
  const platform = {
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
      repositoryGuide(bot.capabilities, ref, bot.agentIdentity),
    diagnostics: {
      showUsageSummary: false,
    },
  };

  const { responder } = createProgressiveRenderer({
    label: "GitHub",
    maxLength: GITHUB_MAX_COMMENT_LENGTH,
    formatContinuation: formatGithubContinuation,
    errorPrefix: "**Error:** ",
    formatToolResult: formatMarkdownToolResult,
    logIntermediateResponses: true,
    responseErrorContext: (responseId) => ({
      platform: "github",
      conversationId,
      messageId: message.id,
      sessionKey: message.sessionKey,
      responseMessageId: responseId === null ? null : Number(responseId),
      conversationKind: message.conversationKind,
    }),
    post: async (text) => {
      return String(await bot.postComment(ref, text));
    },
    update: (id, text) => bot.updateMessage(conversationId, id, text),
    postExtra: async (text) => bot.postComment(ref, text),
    delete: async (id) => {
      await bot.deleteComment(ref, Number(id));
    },
    logBotResponse: (text, id) =>
      bot.logBotResponse(conversationId, text, id, undefined, {
        answer: { replyTo: message.id, sessionKey: message.sessionKey },
      }),
    uploadFallbackNote: (name) =>
      `*(file \`${name}\` was produced, but the GitHub adapter cannot attach files to comments)*`,
    react: (emoji) => bot.addReaction(conversationId, event.ts, emoji),
  });

  return { address: message.address, message, responder, platform };
}
