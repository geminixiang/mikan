import type {
  ChatToolResult,
  ConversationResponder,
  SubagentProgressSnapshot,
} from "../adapter.js";
import * as log from "../log.js";
import { formatToolArgs, splitText, type ChatResponseErrorOperation } from "./shared.js";
import { BufferedResponseStream, OrderedResponseOperations } from "./streaming.js";

/**
 * The per-platform verbs and policy behind one buffered responder. Everything
 * else — the accumulated-text state machine, split-first-then-continuations
 * posting, response-id capture, ordered-queue error choreography, typing
 * interval, working indicator, delete semantics — is owned by
 * {@link createBufferedResponder} and identical on every buffered platform.
 * (Slack keeps its own streaming lifecycle; this covers the platforms that
 * edit one response message in place.)
 */
export interface BufferedResponderPlatform {
  /** Log label, e.g. "Discord". */
  label: string;
  /** Hard message length; longer responses continue in extra messages. */
  maxLength: number;
  formatContinuation: (partNum: number) => string;
  /** Prefix for respondDiagnostic({style:"error"}). */
  errorPrefix: string;
  /** Platform text normalization applied before accumulation (e.g. HTML). */
  sanitize?: (text: string) => string;
  /**
   * Suffix rendered while the run is working (and re-rendered away by
   * setWorking(false)). Platforms without one leave setWorking to typing.
   */
  workingIndicator?: string;
  /** Enable appendResponseDelta/finishResponse over a buffered stream. */
  streaming: boolean;
  /** Render a live subagent snapshot before it enters the shared response queue. */
  formatSubagentProgress?: (progress: SubagentProgressSnapshot) => string;
  typing?: {
    send: () => Promise<unknown>;
    intervalMs: number;
    /** Also stop the indicator when a message is actually sent. */
    stopOnSend?: boolean;
  };
  formatToolResult: (result: ChatToolResult) => string;
  reportError: (
    err: unknown,
    operation: ChatResponseErrorOperation,
    extra: Record<string, unknown>,
  ) => void;
  /** Posted into the conversation after a send fails (e.g. Telegram's ⚠️). */
  notifySendFailure?: (errorMessage: string) => Promise<void>;
  /** Post the first response message; returns its platform id. */
  post: (text: string) => Promise<string>;
  /** Edit the existing response message. */
  update: (id: string, text: string) => Promise<void>;
  /** Post an out-of-band message (continuations, diagnostics). */
  postExtra: (text: string, responseId: string | null) => Promise<unknown>;
  /** Delete the response message. */
  delete?: (id: string) => Promise<void>;
  /** Record a bot response chunk against the response message id. */
  logBotResponse?: (text: string, id: string) => void;
  /** Direct upload; absent platforms fall back to uploadFallbackNote. */
  uploadFile?: (filePath: string, title?: string) => Promise<void>;
  /** Posted (queued) instead of uploading when uploadFile is absent. */
  uploadFallbackNote?: (name: string) => string;
  react?: (emoji: string) => Promise<void>;
}

/** The tool-result rendering shared by the Markdown platforms (Discord, GitHub). */
export function formatMarkdownToolResult(result: ChatToolResult): string {
  const argsFormatted = formatToolArgs(result.args);
  const duration = (result.durationMs / 1000).toFixed(1);
  let text = `**${result.isError ? "Error" : "Done"} ${result.toolName}**`;
  if (result.label) text += `: ${result.label}`;
  text += ` (${duration}s)\n`;
  if (argsFormatted) text += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
  text += `**Result:**\n\`\`\`\n${result.result}\n\`\`\``;
  return text;
}

export function createBufferedResponder(platform: BufferedResponderPlatform): {
  responder: ConversationResponder;
} {
  let responseId: string | null = null;
  let accumulatedText = "";
  let isWorking = true;
  const queue = new OrderedResponseOperations();
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  let typingFailureWarned = false;

  const sanitize = platform.sanitize ?? ((text: string) => text);

  function stopTyping(): void {
    if (typingInterval !== null) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
  }

  /** The response text as currently displayed (working indicator applied). */
  function render(text: string): string {
    return platform.workingIndicator && isWorking ? text + platform.workingIndicator : text;
  }

  async function postOrUpdate(displayText: string): Promise<void> {
    if (responseId !== null) {
      await platform.update(responseId, displayText);
      return;
    }
    if (platform.typing?.stopOnSend) stopTyping();
    responseId = await platform.post(displayText);
  }

  async function postExtra(text: string): Promise<void> {
    if (platform.typing?.stopOnSend) stopTyping();
    await platform.postExtra(text, responseId);
  }

  async function postSplit(text: string): Promise<void> {
    const [head, ...tail] = splitText(text, platform.maxLength, platform.formatContinuation);
    await postOrUpdate(head);
    for (const part of tail) {
      await postExtra(part);
    }
  }

  const stream = new BufferedResponseStream({
    flush: async (text) => {
      await postSplit(render(text));
    },
    finish: async (text) => {
      isWorking = false;
      stopTyping();
      await postSplit(text);
    },
  });

  function run(
    label: string,
    operation: ChatResponseErrorOperation,
    work: () => Promise<void>,
    extra: (err: unknown) => Record<string, unknown>,
  ): Promise<void> {
    return queue.run(work, async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.logWarning(`${platform.label} ${label} error`, message);
      platform.reportError(err, operation, extra(err));
      if (platform.notifySendFailure) {
        try {
          await platform.notifySendFailure(message);
        } catch {
          // ignore secondary failure
        }
      }
    });
  }

  const responder: ConversationResponder = {
    respond: async (text: string) => {
      await run(
        "respond",
        "respond",
        async () => {
          const sanitized = sanitize(text);
          accumulatedText = accumulatedText ? `${accumulatedText}\n${sanitized}` : sanitized;
          stream.setText(accumulatedText);
          await postSplit(render(accumulatedText));
          if (responseId !== null) {
            platform.logBotResponse?.(text, responseId);
          }
        },
        () => ({
          phase: responseId ? "update" : "initial_post",
          textLength: text.length,
          accumulatedLength: accumulatedText.length,
        }),
      );
    },

    ...(platform.streaming
      ? {
          appendResponseDelta: async (delta: string) => {
            await run(
              "appendResponseDelta",
              "respond",
              async () => {
                await stream.append(sanitize(delta));
                accumulatedText = stream.getText();
                if (responseId !== null) {
                  platform.logBotResponse?.(delta, responseId);
                }
              },
              () => ({ textLength: delta.length, accumulatedLength: stream.getText().length }),
            );
          },

          finishResponse: async (finalText?: string) => {
            await run(
              "finishResponse",
              "set_working",
              async () => {
                await stream.finish(finalText === undefined ? undefined : sanitize(finalText));
                accumulatedText = stream.getText();
              },
              () => ({ finalTextLength: finalText?.length }),
            );
          },
        }
      : {}),

    replaceResponse: async (text: string) => {
      await run(
        "replaceResponse",
        "replace_response",
        async () => {
          accumulatedText = sanitize(text);
          stream.setText(accumulatedText);
          await postSplit(accumulatedText);
        },
        () => ({
          textLength: text.length,
          hadExistingResponse: Boolean(responseId),
        }),
      );
    },

    replaceSubagentProgress: platform.formatSubagentProgress
      ? async (progress: SubagentProgressSnapshot, finalText?: string) => {
          const dashboard = platform.formatSubagentProgress!(progress);
          await responder.replaceResponse(finalText ? `${dashboard}\n\n${finalText}` : dashboard);
        }
      : undefined,

    respondDiagnostic: async (text: string, options?: { style?: "muted" | "error" }) => {
      await run(
        "respondDiagnostic",
        "respond_diagnostic",
        async () => {
          const prefix = options?.style === "error" ? platform.errorPrefix : "";
          for (const part of splitText(
            sanitize(`${prefix}${text}`),
            platform.maxLength,
            platform.formatContinuation,
          )) {
            await postExtra(part);
          }
        },
        () => ({ textLength: text.length, style: options?.style }),
      );
    },

    respondToolResult: async (result: ChatToolResult) => {
      await responder.respondDiagnostic(platform.formatToolResult(result));
    },

    setTyping: async (isTyping: boolean) => {
      const typing = platform.typing;
      if (!typing) return;
      const onTypingError = (err: unknown): void => {
        if (typingFailureWarned) return;
        typingFailureWarned = true;
        log.logWarning(
          `${platform.label} sendTyping failed (further occurrences suppressed for this session)`,
          err instanceof Error ? err.message : String(err),
        );
      };
      if (isTyping && typingInterval === null) {
        typing.send().catch(onTypingError);
        typingInterval = setInterval(() => {
          typing.send().catch(onTypingError);
        }, typing.intervalMs);
      } else if (!isTyping) {
        stopTyping();
      }
    },

    setWorking: async (working: boolean) => {
      if (!platform.workingIndicator) {
        if (!working) stopTyping();
        return;
      }
      await run(
        "setWorking",
        "set_working",
        async () => {
          isWorking = working;
          if (!working) stopTyping();
          if (responseId !== null) {
            const [head] = splitText(
              render(accumulatedText),
              platform.maxLength,
              platform.formatContinuation,
            );
            await platform.update(responseId, head);
          }
        },
        () => ({ working }),
      );
    },

    uploadFile: async (filePath: string, title?: string) => {
      if (platform.uploadFile) {
        await platform.uploadFile(filePath, title);
        return;
      }
      const note = platform.uploadFallbackNote?.(title ?? filePath);
      if (note === undefined) return;
      await run(
        "uploadFile",
        "respond_diagnostic",
        () => postExtra(note),
        () => ({ filePath }),
      );
    },

    ...(platform.react ? { react: platform.react } : {}),

    deleteResponse: async () => {
      await queue.run(async () => {
        stopTyping();
        if (responseId !== null) {
          try {
            await platform.delete?.(responseId);
          } catch {
            // Ignore errors
          }
          responseId = null;
        }
      });
    },
  };

  return { responder };
}
