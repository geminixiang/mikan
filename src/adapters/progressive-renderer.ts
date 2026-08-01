import type {
  ChatToolResult,
  ConversationResponder,
  SubagentProgressSnapshot,
} from "../adapter.js";
import * as log from "../log.js";
import {
  createChatResponseErrorReporter,
  formatToolArgs,
  splitText,
  type ChatResponseErrorOperation,
} from "./shared.js";
import type { ProgressiveRendererPlatform } from "./types.js";

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

interface RendererState {
  responseId: string | null;
  source: string;
  working: boolean;
  streamActive: boolean;
  streamUnavailable: boolean;
  streamedSource: string;
  pendingChars: number;
  lastFlushAt: number;
  resetDelta: boolean;
  typingInterval: ReturnType<typeof setInterval> | null;
  typingFailureWarned: boolean;
  extraIds: Array<string | number>;
}

/**
 * Floor on how often a streaming response redraws.
 *
 * Every platform meters edits per channel — Slack's is the tightest at roughly
 * fifty a minute — and a redraw sends the whole message, so the cost is the
 * number of calls, not their size. One second keeps a long answer inside that
 * budget while still reading as live.
 *
 * This is a floor, not a target: the interval is measured from when the last
 * redraw *finished*, so a platform that slows down under load slows the redraw
 * rate with it instead of queueing work it cannot deliver.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

export function createProgressiveRenderer(platform: ProgressiveRendererPlatform): {
  responder: ConversationResponder;
} {
  const state: RendererState = {
    responseId: platform.initialResponseId ?? null,
    source: "",
    working: true,
    streamActive: false,
    streamUnavailable: false,
    streamedSource: "",
    pendingChars: 0,
    lastFlushAt: 0,
    resetDelta: false,
    typingInterval: null,
    typingFailureWarned: false,
    extraIds: [],
  };
  const sanitize = platform.sanitize ?? ((text: string) => text);
  const reportResponseError = platform.responseErrorContext
    ? createChatResponseErrorReporter(() => platform.responseErrorContext!(state.responseId))
    : (err: unknown, operation: ChatResponseErrorOperation, extra?: Record<string, unknown>) =>
        platform.reportError?.(err, operation, extra ?? {}, state.responseId);
  const now = Date.now;
  const flushIntervalMs = platform.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

  function stopTyping(): void {
    if (state.typingInterval !== null) {
      clearInterval(state.typingInterval);
      state.typingInterval = null;
    }
  }

  function provisional(text: string, working: boolean): string {
    if (platform.formatProvisional) return platform.formatProvisional(text, working);
    return working && platform.workingIndicator ? text + platform.workingIndicator : text;
  }

  function split(text: string): string[] {
    return splitText(text, platform.maxLength, platform.formatContinuation);
  }

  async function postOrUpdate(text: string): Promise<void> {
    if (state.responseId !== null) {
      await platform.update(state.responseId, text);
      return;
    }
    if (platform.typing?.stopOnSend) stopTyping();
    state.responseId = await platform.post(text);
  }

  async function postSplit(text: string): Promise<void> {
    const [head = text, ...tail] = split(text);
    await postOrUpdate(head);
    for (const part of tail) {
      if (platform.typing?.stopOnSend) stopTyping();
      await platform.postExtra(part, state.responseId);
    }
  }

  async function postExtra(text: string): Promise<void> {
    if (platform.typing?.stopOnSend) stopTyping();
    await platform.postExtra(text, state.responseId);
  }

  async function stopNativeStream(): Promise<void> {
    if (!state.streamActive || state.responseId === null || !platform.stream) return;
    const streamId = state.responseId;
    state.streamActive = false;
    state.streamedSource = "";
    await platform.stream.stop(streamId);
  }

  async function abandonNativeStream(): Promise<void> {
    if (!platform.stream || state.responseId === null) return;
    const streamId = state.responseId;
    state.streamActive = false;
    state.streamedSource = "";
    await platform.stream.stop(streamId).catch(() => undefined);
    if (state.responseId === streamId) state.responseId = null;
  }

  async function renderRaw(
    text: string,
    operation: "render" | "replace",
    options?: { createOverflowLink?: () => string },
    canonicalText = text,
  ): Promise<string> {
    try {
      await postSplit(text);
      return canonicalText;
    } catch (err) {
      if (!platform.handleTooLong) throw err;
      // Only a length rejection may take the truncating path. Treating every
      // failure as "too long" turned a transient rate limit into a response
      // cut to a few thousand characters under a notice blaming its length,
      // and the retry it triggered kept the limit alive.
      if (platform.isTooLongError && !platform.isTooLongError(err)) throw err;
      const fallback = await platform.handleTooLong(
        canonicalText,
        operation,
        options,
        state.responseId,
        postSplit,
        () => state.responseId,
      );
      return fallback.text;
    }
  }

  async function renderDelta(text: string): Promise<string> {
    if (state.working && !text.trim()) return text;
    const prepared = platform.prepareSource?.(text, state.working) ?? text;
    const stream = platform.stream;
    const display = provisional(prepared, state.working);
    if (!stream || state.streamUnavailable) {
      await renderRaw(display, "render", undefined, prepared);
      return prepared;
    }
    if (state.responseId !== null && !state.streamActive) {
      await renderRaw(display, "render", undefined, prepared);
      return prepared;
    }
    if (
      state.responseId !== null &&
      state.streamActive &&
      !prepared.startsWith(state.streamedSource)
    ) {
      await abandonNativeStream();
      await renderRaw(display, "render", undefined, prepared);
      return prepared;
    }

    try {
      if (state.responseId !== null) {
        const delta = prepared.slice(state.streamedSource.length);
        // Below the threshold the delta stays pending: `state.streamedSource`
        // does not advance, so the next tick recomputes it from the same base
        // and `renderFinal` flushes the remainder before stopping.
        if (delta && delta.length >= (stream.minDeltaChars ?? 0)) {
          await stream.append(state.responseId, delta);
          state.streamedSource = prepared;
        }
        return prepared;
      }
      state.responseId = await stream.start(prepared);
      state.streamActive = true;
      state.streamedSource = prepared;
      return prepared;
    } catch (err) {
      state.streamUnavailable = true;
      log.logWarning(
        "Native response streaming unavailable; falling back to message updates",
        err instanceof Error ? err.message : String(err),
      );
      await abandonNativeStream();
      await renderRaw(display, "render", undefined, prepared);
      return prepared;
    }
  }

  async function renderFinal(text: string): Promise<string> {
    const stream = platform.stream;
    if (stream && state.streamActive && state.responseId !== null) {
      let streamed = false;
      try {
        if (text.startsWith(state.streamedSource)) {
          const delta = text.slice(state.streamedSource.length);
          if (delta) await stream.append(state.responseId, delta);
          await stream.stop(state.responseId);
          streamed = true;
        }
      } catch (err) {
        state.streamUnavailable = true;
        log.logWarning(
          "Native response streaming unavailable; falling back to message updates",
          err instanceof Error ? err.message : String(err),
        );
      }
      state.streamActive = false;
      state.streamedSource = "";
      if (streamed) {
        if (platform.needsCanonicalRender?.(text)) await renderRaw(text, "render");
        return text;
      }
      await abandonNativeStream();
    }
    if (state.responseId !== null || text) return renderRaw(text, "render");
    return text;
  }

  async function run(
    label: string,
    operation: ChatResponseErrorOperation,
    work: () => Promise<void>,
    extra: () => Record<string, unknown>,
  ): Promise<void> {
    const operationPromise = queueTail.then(work);
    const handled = operationPromise.catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.logWarning(`${platform.label} ${label} error`, message);
      reportResponseError(err, operation, extra());
      if (platform.notifySendFailure) {
        try {
          await platform.notifySendFailure(message);
        } catch {
          // A secondary notification must not poison the response queue.
        }
      }
    });
    queueTail = handled.catch(() => undefined);
    return handled;
  }

  let queueTail = Promise.resolve();

  async function appendDelta(delta: string): Promise<void> {
    await run(
      "appendResponseDelta",
      "respond",
      async () => {
        if (!delta) return;
        if (state.resetDelta) {
          state.source = "";
          state.pendingChars = 0;
          state.resetDelta = false;
        }
        const sanitized = sanitize(delta);
        state.source += sanitized;
        state.pendingChars += sanitized.length;
        const elapsed = now() - state.lastFlushAt;
        // A character threshold must not bypass the interval. When it did, a
        // fast stream redrew every eighty characters — well over a hundred
        // edits for a long answer — and the platform started refusing them.
        if (state.lastFlushAt === 0 || (elapsed >= flushIntervalMs && state.pendingChars > 0)) {
          state.pendingChars = 0;
          state.source = await renderDelta(state.source);
          // Stamp on completion: a slow or retrying send pushes the next
          // redraw out by however long it took, so pressure never compounds.
          state.lastFlushAt = now();
        }
      },
      () => ({ textLength: delta.length, accumulatedLength: state.source.length }),
    );
  }

  const responder: ConversationResponder = {
    respond: async (text: string) => {
      await run(
        "respond",
        "respond",
        async () => {
          const sanitized = sanitize(text);
          state.source = state.source ? `${state.source}\n${sanitized}` : sanitized;
          state.pendingChars = 0;
          state.source = await renderDelta(state.source);
          if (state.responseId !== null && platform.logIntermediateResponses) {
            platform.logBotResponse?.(text, state.responseId);
          }
        },
        () => ({
          phase: state.responseId ? "update" : "initial_post",
          textLength: text.length,
          accumulatedLength: state.source.length,
        }),
      );
    },

    appendResponseDelta: platform.supportsDeltas || platform.stream ? appendDelta : undefined,

    finishResponse:
      platform.supportsDeltas || platform.stream
        ? async (finalText?: string) => {
            await run(
              "finishResponse",
              "set_working",
              async () => {
                if (finalText !== undefined) state.source = sanitize(finalText);
                state.resetDelta = false;
                state.pendingChars = 0;
                stopTyping();
                state.working = false;
                state.source = await renderFinal(state.source);
                if (state.responseId !== null)
                  platform.logBotResponse?.(state.source, state.responseId);
                await platform.onFinish?.(state.source, state.responseId);
              },
              () => ({ finalTextLength: finalText?.length }),
            );
          }
        : undefined,

    replaceResponse: async (text: string, options?: { createOverflowLink?: () => string }) => {
      await run(
        "replaceResponse",
        "replace_response",
        async () => {
          state.source = sanitize(text);
          state.pendingChars = 0;
          state.resetDelta = true;
          if (state.streamActive) await stopNativeStream();
          if (state.working && !state.source.trim()) return;
          // Prepare here too, not only on the delta path. This render is the
          // last word on the response, so skipping it let the canonical
          // replace overwrite prepared text with the raw source — a Discord
          // table converted during streaming reverted to literal pipes the
          // moment the run finished.
          const prepared = platform.prepareSource?.(state.source, state.working) ?? state.source;
          state.source = await renderRaw(
            provisional(prepared, state.working),
            "replace",
            options,
            // The prepared text is what was sent, so it is also what the
            // renderer must remember it sent.
            prepared,
          );
        },
        () => ({
          textLength: text.length,
          hadExistingResponse: Boolean(state.responseId),
        }),
      );
    },

    replaceSubagentProgress: platform.formatSubagentProgress
      ? async (progress: SubagentProgressSnapshot, finalText?: string) => {
          const dashboard = platform.formatSubagentProgress!(progress);
          await responder.replaceResponse(finalText ? `${dashboard}\n\n${finalText}` : dashboard);
        }
      : undefined,

    respondDiagnostic: async (text, options = {}) => {
      await run(
        "respondDiagnostic",
        "respond_diagnostic",
        async () => {
          const ids = platform.postDiagnostic
            ? await platform.postDiagnostic(text, options, state.responseId)
            : await postDefaultDiagnostic(text, options);
          state.extraIds.push(...ids);
        },
        () => ({ textLength: text.length, style: options.style }),
      );
    },

    respondToolResult: async (result: ChatToolResult) => {
      await responder.respondDiagnostic(platform.formatToolResult(result));
    },

    setTyping: async (isTyping: boolean) => {
      await run(
        "setTyping",
        "set_working",
        async () => {
          if (platform.setTyping) {
            await platform.setTyping(isTyping, state.responseId);
            return;
          }
          const typing = platform.typing;
          if (!typing) return;
          const onTypingError = (err: unknown): void => {
            if (state.typingFailureWarned) return;
            state.typingFailureWarned = true;
            log.logWarning(
              `${platform.label} sendTyping failed (further occurrences suppressed for this session)`,
              err instanceof Error ? err.message : String(err),
            );
          };
          if (isTyping && state.typingInterval === null) {
            typing.send().catch(onTypingError);
            state.typingInterval = setInterval(() => {
              typing.send().catch(onTypingError);
            }, typing.intervalMs);
          } else if (!isTyping) {
            stopTyping();
          }
        },
        () => ({ working: isTyping }),
      );
    },

    setWorking: async (working: boolean) => {
      await run(
        "setWorking",
        "set_working",
        async () => {
          state.working = working;
          if (!working) stopTyping();
          await platform.onWorkingChanged?.(working, state.responseId);
          if (state.responseId === null || (!platform.workingIndicator && !platform.stream)) return;
          if (working && !state.source.trim()) return;

          if (state.streamActive && !working) {
            await stopNativeStream();
            return;
          }
          if (state.responseId !== null) {
            state.source = await renderRaw(
              provisional(state.source, working),
              "render",
              undefined,
              state.source,
            );
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
      await run(
        "deleteResponse",
        "respond",
        async () => {
          stopTyping();
          if (state.streamActive) await stopNativeStream().catch(() => undefined);
          for (const id of state.extraIds) {
            try {
              await platform.deleteExtra?.(id);
            } catch {
              // Deleting diagnostics is best effort.
            }
          }
          state.extraIds = [];
          if (state.responseId !== null) {
            try {
              await platform.delete?.(state.responseId);
            } catch {
              // Deleting the main response is best effort.
            }
          }
          state.responseId = null;
          state.source = "";
          state.streamUnavailable = false;
          state.streamedSource = "";
          state.streamActive = false;
          state.resetDelta = false;
          state.working = true;
        },
        () => ({}),
      );
    },
  };

  async function postDefaultDiagnostic(
    text: string,
    options: { style?: "muted" | "error" },
  ): Promise<Array<string | number>> {
    const prefix = options.style === "error" ? platform.errorPrefix : "";
    const ids: Array<string | number> = [];
    for (const part of split(sanitize(`${prefix}${text}`))) {
      const id = await platform.postExtra(part, state.responseId);
      if (typeof id === "string" || typeof id === "number") ids.push(id);
    }
    return ids;
  }

  return { responder };
}
