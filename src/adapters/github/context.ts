import type {
  ChatToolResult,
  ConversationMessage,
  ConversationResponder,
  MessagingInfo,
} from "../../adapter.js";
import * as log from "../../log.js";
import { resolveChatSessionKey } from "../../sessions/policy.js";
import {
  createChatResponseErrorReporter,
  formatToolArgs,
  splitText,
  type ChatResponseErrorOperation,
} from "../shared.js";
import {
  formatGithubContinuation,
  GITHUB_MAX_COMMENT_LENGTH,
  type GithubMessagingBot,
} from "./bot.js";
import { parseGithubConversationId } from "./ids.js";
import type { GithubEvent } from "./types.js";

const GITHUB_FORMATTING_GUIDE = `## GitHub Formatting (GitHub Flavored Markdown)
Standard Markdown plus tables, task lists, and fenced code blocks.
Reference issues/PRs as #123 and users as @login (mentions notify people — use sparingly).`;

function formatToolResult(result: ChatToolResult): string {
  const argsFormatted = formatToolArgs(result.args);
  const duration = (result.durationMs / 1000).toFixed(1);
  let text = `**${result.isError ? "Error" : "Done"} ${result.toolName}**`;
  if (result.label) text += `: ${result.label}`;
  text += ` (${duration}s)\n`;
  if (argsFormatted) text += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
  text += `**Result:**\n\`\`\`\n${result.result}\n\`\`\``;
  return text;
}

export function createGithubAdapters(
  event: GithubEvent,
  bot: GithubMessagingBot,
): {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
} {
  let commentId: number | null = null;
  let accumulatedText = "";
  let updatePromise = Promise.resolve();

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

  const platform: MessagingInfo = {
    name: "github",
    trustModel: "open-trigger",
    formattingGuide:
      `${GITHUB_FORMATTING_GUIDE}\n\n` +
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
    channels: [],
    users: [],
    diagnostics: {
      showUsageSummary: false,
    },
  };

  const reportResponseError = createChatResponseErrorReporter(() => ({
    platform: "github",
    conversationId,
    messageId: message.id,
    sessionKey: message.sessionKey,
    responseMessageId: commentId,
    conversationKind: message.conversationKind,
  }));

  async function postOrUpdateResponse(displayText: string): Promise<void> {
    if (commentId !== null) {
      await bot.updateMessage(conversationId, String(commentId), displayText);
    } else {
      commentId = await bot.postComment(ref, displayText);
    }
  }

  async function postSplitResponse(text: string): Promise<void> {
    const [displayText, ...extraParts] = splitText(
      text,
      GITHUB_MAX_COMMENT_LENGTH,
      formatGithubContinuation,
    );
    await postOrUpdateResponse(displayText);
    for (const part of extraParts) {
      await bot.postComment(ref, part);
    }
  }

  async function queueGithubResponse(
    label: string,
    operation: ChatResponseErrorOperation,
    work: () => Promise<void>,
    extra: () => Record<string, unknown>,
  ): Promise<void> {
    updatePromise = updatePromise.then(async () => {
      try {
        await work();
      } catch (err) {
        log.logWarning(`GitHub ${label} error`, err instanceof Error ? err.message : String(err));
        reportResponseError(err, operation, extra());
      }
    });
    await updatePromise;
  }

  // No appendResponseDelta/finishResponse: GitHub gets the finished response
  // in one comment. Streaming would edit the comment on every flush — API
  // churn and "edited" noise for readers who refresh rather than watch typing.
  const responder: ConversationResponder = {
    respond: async (text: string) => {
      await queueGithubResponse(
        "respond",
        "respond",
        async () => {
          accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
          await postSplitResponse(accumulatedText);
          if (commentId !== null) {
            bot.logBotResponse(conversationId, text, String(commentId));
          }
        },
        () => ({
          phase: commentId ? "update" : "initial_post",
          textLength: text.length,
          accumulatedLength: accumulatedText.length,
        }),
      );
    },

    replaceResponse: async (text: string) => {
      await queueGithubResponse(
        "replaceResponse",
        "replace_response",
        async () => {
          accumulatedText = text;
          await postSplitResponse(accumulatedText);
        },
        () => ({
          textLength: text.length,
          hadExistingResponse: Boolean(commentId),
        }),
      );
    },

    respondDiagnostic: async (text: string, options?: { style?: "muted" | "error" }) => {
      await queueGithubResponse(
        "respondDiagnostic",
        "respond_diagnostic",
        async () => {
          const prefix = options?.style === "error" ? "**Error:** " : "";
          for (const part of splitText(
            `${prefix}${text}`,
            GITHUB_MAX_COMMENT_LENGTH,
            formatGithubContinuation,
          )) {
            await bot.postComment(ref, part);
          }
        },
        () => ({ textLength: text.length, style: options?.style }),
      );
    },

    respondToolResult: async (result: ChatToolResult) => {
      await responder.respondDiagnostic(formatToolResult(result));
    },

    // GitHub has no typing indicator; progress shows through comment edits.
    setTyping: async () => {},

    setWorking: async () => {},

    uploadFile: async (filePath: string, title?: string) => {
      // The REST API cannot attach files to comments (uploads are a browser
      // feature); leave a pointer instead of failing the run.
      const name = title ?? filePath;
      await queueGithubResponse(
        "uploadFile",
        "respond_diagnostic",
        async () => {
          await bot.postComment(
            ref,
            `*(file \`${name}\` was produced, but the GitHub adapter cannot attach files to comments)*`,
          );
        },
        () => ({ filePath }),
      );
    },

    react: async (emoji: string) => {
      await bot.addReaction(conversationId, event.ts, emoji);
    },

    deleteResponse: async () => {
      updatePromise = updatePromise.then(async () => {
        if (commentId !== null) {
          try {
            await bot.deleteComment(ref, commentId);
          } catch {
            // Ignore errors
          }
          commentId = null;
        }
      });
      await updatePromise;
    },
  };

  return { message, responder, platform };
}
