import type {
  ConversationMessage,
  ConversationResponder,
  ChatToolResult,
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
import { BufferedResponseStream, OrderedResponseOperations } from "../streaming.js";
import type { DiscordMessagingBot, DiscordEvent } from "./bot.js";

const DISCORD_FORMATTING_GUIDE = `## Discord Formatting (Markdown)
Bold: **text**, Italic: *text*, Code: \`code\`, Block: \`\`\`language\ncode\`\`\`
Links: [text](url), Spoiler: ||text||
Keep messages under 2000 characters. Use code blocks for code.`;

// Discord hard limit is 2000 chars; 1900 leaves headroom for working indicator.
const MAX_LENGTH = 1900;

const formatDiscordContinuation = (partNum: number): string => `*(continued ${partNum})*`;

function isDiscordMessageReference(id: string | undefined): id is string {
  return typeof id === "string" && id !== "" && !id.startsWith("event:");
}

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

export function createDiscordAdapters(
  event: DiscordEvent,
  bot: DiscordMessagingBot,
): {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
} {
  let messageId: string | null = null;
  let accumulatedText = "";
  let isWorking = true;
  const workingIndicator = " ...";
  const responseOperations = new OrderedResponseOperations();
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  let typingFailureWarned = false;

  function stopTyping(): void {
    if (typingInterval !== null) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  }

  const conversationId = event.conversationId;
  const channelId = conversationId;
  const threadTargetId = isDiscordMessageReference(event.thread_ts) ? event.thread_ts : undefined;
  const replyTargetId = isDiscordMessageReference(event.ts) ? event.ts : undefined;

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
    name: "discord",
    trustModel: "membership",
    formattingGuide: DISCORD_FORMATTING_GUIDE,
    channels: bot.getAllChannels(),
    users: bot.getAllUsers(),
    diagnostics: {
      showUsageSummary: false,
    },
  };

  async function postDiagnosticMessage(text: string): Promise<string> {
    stopTyping();
    if (threadTargetId) {
      return bot.postInThread(channelId, threadTargetId, text);
    }
    if (replyTargetId) {
      return bot.postReply(channelId, replyTargetId, text);
    }
    if (messageId !== null) {
      return bot.postReply(channelId, messageId, text);
    }
    return bot.postMessage(channelId, text);
  }

  const reportResponseError = createChatResponseErrorReporter(() => ({
    platform: "discord",
    conversationId,
    channelId,
    messageId: message.id,
    sessionKey: message.sessionKey,
    responseMessageId: messageId,
    threadTs: threadTargetId,
    replyTargetId,
    conversationKind: message.conversationKind,
  }));

  async function postOrUpdateResponse(displayText: string): Promise<void> {
    if (messageId !== null) {
      await bot.updateMessageRaw(channelId, messageId, displayText);
      return;
    }
    stopTyping();
    if (threadTargetId) {
      messageId = await bot.postInThread(channelId, threadTargetId, displayText);
    } else if (replyTargetId) {
      messageId = await bot.postReply(channelId, replyTargetId, displayText);
    } else {
      messageId = await bot.postMessage(channelId, displayText);
    }
  }

  async function postSplitResponse(text: string): Promise<void> {
    const [displayText, ...extraParts] = splitText(text, MAX_LENGTH, formatDiscordContinuation);
    await postOrUpdateResponse(displayText);
    for (const part of extraParts) {
      await postDiagnosticMessage(part);
    }
  }

  const stream = new BufferedResponseStream({
    flush: async (text) => {
      await postSplitResponse(isWorking ? text + workingIndicator : text);
    },
    finish: async (text) => {
      isWorking = false;
      stopTyping();
      await postSplitResponse(text);
    },
  });

  function queueDiscordResponse(
    label: string,
    operation: ChatResponseErrorOperation,
    work: () => Promise<void>,
    report: (err: unknown) => Record<string, unknown>,
  ): Promise<void> {
    return responseOperations.run(work, (err) => {
      log.logWarning(`Discord ${label} error`, err instanceof Error ? err.message : String(err));
      reportResponseError(err, operation, report(err));
    });
  }

  const responder: ConversationResponder = {
    respond: async (text: string) => {
      await queueDiscordResponse(
        "respond",
        "respond",
        async () => {
          accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
          stream.setText(accumulatedText);
          await postSplitResponse(isWorking ? accumulatedText + workingIndicator : accumulatedText);
          if (messageId !== null) {
            bot.logBotResponse(channelId, text, messageId);
          }
        },
        () => ({
          phase: messageId ? "update" : "initial_post",
          textLength: text.length,
          accumulatedLength: accumulatedText.length,
        }),
      );
    },

    appendResponseDelta: async (delta: string) => {
      await queueDiscordResponse(
        "appendResponseDelta",
        "respond",
        async () => {
          await stream.append(delta);
          accumulatedText = stream.getText();
          if (messageId !== null) {
            bot.logBotResponse(channelId, delta, messageId);
          }
        },
        () => ({ textLength: delta.length, accumulatedLength: stream.getText().length }),
      );
    },

    finishResponse: async (finalText?: string) => {
      await queueDiscordResponse(
        "finishResponse",
        "set_working",
        async () => {
          await stream.finish(finalText);
          accumulatedText = stream.getText();
        },
        () => ({ finalTextLength: finalText?.length }),
      );
    },

    replaceResponse: async (text: string) => {
      await queueDiscordResponse(
        "replaceResponse",
        "replace_response",
        async () => {
          accumulatedText = text;
          stream.setText(accumulatedText);
          await postSplitResponse(accumulatedText);
        },
        () => ({
          textLength: text.length,
          hadExistingResponse: Boolean(messageId),
        }),
      );
    },

    respondDiagnostic: async (text: string, options?: { style?: "muted" | "error" }) => {
      await queueDiscordResponse(
        "respondDiagnostic",
        "respond_diagnostic",
        async () => {
          const prefix = options?.style === "error" ? "*Error:* " : "";
          for (const part of splitText(`${prefix}${text}`, MAX_LENGTH, formatDiscordContinuation)) {
            await postDiagnosticMessage(part);
          }
        },
        () => ({
          textLength: text.length,
          style: options?.style,
        }),
      );
    },

    respondToolResult: async (result: ChatToolResult) => {
      await responder.respondDiagnostic(formatToolResult(result));
    },

    setTyping: async (isTyping: boolean) => {
      const onTypingError = (err: unknown): void => {
        if (typingFailureWarned) return;
        typingFailureWarned = true;
        log.logWarning(
          "Discord sendTyping failed (further occurrences suppressed for this session)",
          err instanceof Error ? err.message : String(err),
        );
      };
      if (isTyping && typingInterval === null) {
        // Send immediately and repeat every 8s (Discord clears indicator after ~10s)
        bot.sendTyping(channelId).catch(onTypingError);
        typingInterval = setInterval(() => {
          bot.sendTyping(channelId).catch(onTypingError);
        }, 8000);
      } else if (!isTyping) {
        stopTyping();
      }
    },

    setWorking: async (working: boolean) => {
      await queueDiscordResponse(
        "setWorking",
        "set_working",
        async () => {
          isWorking = working;
          if (!working) stopTyping();
          if (messageId !== null) {
            const [displayText] = splitText(
              isWorking ? accumulatedText + workingIndicator : accumulatedText,
              MAX_LENGTH,
              formatDiscordContinuation,
            );
            await bot.updateMessageRaw(channelId, messageId, displayText);
          }
        },
        () => ({ working }),
      );
    },

    uploadFile: async (filePath: string, title?: string) => {
      await bot.uploadFile(channelId, filePath, title);
    },

    deleteResponse: async () => {
      await responseOperations.run(async () => {
        stopTyping();
        if (messageId !== null) {
          try {
            await bot.deleteMessageRaw(channelId, messageId);
          } catch {
            // Ignore errors
          }
          messageId = null;
        }
      });
    },
  };

  return { message, responder, platform };
}
