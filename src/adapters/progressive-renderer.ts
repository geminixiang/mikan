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
  /**
   * Messages holding the overflow of a response too long for one message,
   * in order. Reused across redraws — see `postSplit`.
   */
  continuationIds: Array<string | number>;
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

class ProgressiveRenderer {
  readonly responder: ConversationResponder;
  private readonly state: RendererState;
  private readonly sanitize: (text: string) => string;
  private readonly reportResponseError;
  private readonly now = Date.now;
  private readonly flushIntervalMs: number;
  private queueTail = Promise.resolve();

  constructor(private readonly platform: ProgressiveRendererPlatform) {
    this.state = {
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
      continuationIds: [],
    };
    this.sanitize = platform.sanitize ?? ((text: string) => text);
    this.reportResponseError = platform.responseErrorContext
      ? createChatResponseErrorReporter(() => platform.responseErrorContext!(this.state.responseId))
      : undefined;
    this.flushIntervalMs = platform.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.responder = this.createResponder();
  }

  private createResponder(): ConversationResponder {
    return {
      respond: (text) => this.respond(text),
      appendResponseDelta:
        this.platform.supportsDeltas || this.platform.stream
          ? (delta) => this.appendDelta(delta)
          : undefined,
      finishResponse:
        this.platform.supportsDeltas || this.platform.stream
          ? (finalText) => this.finishResponse(finalText)
          : undefined,
      replaceResponse: (text, options) => this.replaceResponse(text, options),
      replaceSubagentProgress: this.platform.formatSubagentProgress
        ? (progress, finalText) => this.replaceSubagentProgress(progress, finalText)
        : undefined,
      respondDiagnostic: (text, options) => this.respondDiagnostic(text, options),
      respondToolResult: (result) => this.respondToolResult(result),
      setTyping: (isTyping) => this.setTyping(isTyping),
      setWorking: (working) => this.setWorking(working),
      uploadFile: (filePath, title) => this.uploadFile(filePath, title),
      ...(this.platform.react ? { react: this.platform.react } : {}),
      deleteResponse: () => this.deleteResponse(),
    };
  }

  private stopTyping(): void {
    if (this.state.typingInterval !== null) {
      clearInterval(this.state.typingInterval);
      this.state.typingInterval = null;
    }
  }

  private provisional(text: string, working: boolean): string {
    if (this.platform.formatProvisional) return this.platform.formatProvisional(text, working);
    return working && this.platform.workingIndicator ? text + this.platform.workingIndicator : text;
  }

  private split(text: string): string[] {
    return splitText(text, this.platform.maxLength, this.platform.formatContinuation);
  }

  private async postOrUpdate(text: string): Promise<void> {
    if (this.state.responseId !== null) {
      await this.platform.update(this.state.responseId, text);
      return;
    }
    if (this.platform.typing?.stopOnSend) this.stopTyping();
    this.state.responseId = await this.platform.post(text);
  }

  private async postSplit(text: string): Promise<void> {
    const [head = text, ...tail] = this.split(text);
    await this.postOrUpdate(head);
    for (const [index, part] of tail.entries()) {
      const existing = this.state.continuationIds[index];
      if (existing !== undefined) {
        await this.platform.update(String(existing), part);
        continue;
      }
      if (this.platform.typing?.stopOnSend) this.stopTyping();
      const id = await this.platform.postExtra(part, this.state.responseId);
      if (id !== undefined && id !== null) this.state.continuationIds[index] = id;
    }
  }

  private async postExtra(text: string): Promise<void> {
    if (this.platform.typing?.stopOnSend) this.stopTyping();
    await this.platform.postExtra(text, this.state.responseId);
  }

  private async stopNativeStream(): Promise<void> {
    if (!this.state.streamActive || this.state.responseId === null || !this.platform.stream) return;
    const streamId = this.state.responseId;
    this.state.streamActive = false;
    this.state.streamedSource = "";
    await this.platform.stream.stop(streamId);
  }

  private async abandonNativeStream(): Promise<void> {
    if (!this.platform.stream || this.state.responseId === null) return;
    const streamId = this.state.responseId;
    this.state.streamActive = false;
    this.state.streamedSource = "";
    await this.platform.stream.stop(streamId).catch(() => undefined);
    if (this.state.responseId === streamId) this.state.responseId = null;
  }

  private async renderRaw(
    text: string,
    operation: "render" | "replace",
    options?: { createOverflowLink?: () => string },
    canonicalText = text,
  ): Promise<string> {
    try {
      await this.postSplit(text);
      return canonicalText;
    } catch (err) {
      if (!this.platform.handleTooLong) throw err;
      if (this.platform.isTooLongError && !this.platform.isTooLongError(err)) throw err;
      const fallback = await this.platform.handleTooLong({
        text: canonicalText,
        operation,
        options,
        responseId: this.state.responseId,
        write: (fallbackText) => this.postSplit(fallbackText),
        getResponseId: () => this.state.responseId,
      });
      return fallback.text;
    }
  }

  private async renderDelta(text: string): Promise<string> {
    if (this.state.working && !text.trim()) return text;
    const prepared = this.platform.prepareSource?.(text, this.state.working) ?? text;
    const stream = this.platform.stream;
    const display = this.provisional(prepared, this.state.working);
    if (!stream || this.state.streamUnavailable) {
      await this.renderRaw(display, "render", undefined, prepared);
      return prepared;
    }
    if (this.state.responseId !== null && !this.state.streamActive) {
      await this.renderRaw(display, "render", undefined, prepared);
      return prepared;
    }
    if (
      this.state.responseId !== null &&
      this.state.streamActive &&
      !prepared.startsWith(this.state.streamedSource)
    ) {
      await this.abandonNativeStream();
      await this.renderRaw(display, "render", undefined, prepared);
      return prepared;
    }

    try {
      if (this.state.responseId !== null) {
        const delta = prepared.slice(this.state.streamedSource.length);
        if (delta && delta.length >= (stream.minDeltaChars ?? 0)) {
          await stream.append(this.state.responseId, delta);
          this.state.streamedSource = prepared;
        }
        return prepared;
      }
      this.state.responseId = await stream.start(prepared);
      this.state.streamActive = true;
      this.state.streamedSource = prepared;
      return prepared;
    } catch (err) {
      this.state.streamUnavailable = true;
      log.logWarning(
        "Native response streaming unavailable; falling back to message updates",
        err instanceof Error ? err.message : String(err),
      );
      await this.abandonNativeStream();
      await this.renderRaw(display, "render", undefined, prepared);
      return prepared;
    }
  }

  private async renderFinal(text: string): Promise<string> {
    const stream = this.platform.stream;
    if (stream && this.state.streamActive && this.state.responseId !== null) {
      let streamed = false;
      try {
        if (text.startsWith(this.state.streamedSource)) {
          const delta = text.slice(this.state.streamedSource.length);
          if (delta) await stream.append(this.state.responseId, delta);
          await stream.stop(this.state.responseId);
          streamed = true;
        }
      } catch (err) {
        this.state.streamUnavailable = true;
        log.logWarning(
          "Native response streaming unavailable; falling back to message updates",
          err instanceof Error ? err.message : String(err),
        );
      }
      this.state.streamActive = false;
      this.state.streamedSource = "";
      if (streamed) {
        if (this.platform.needsCanonicalRender?.(text)) await this.renderRaw(text, "render");
        return text;
      }
      await this.abandonNativeStream();
    }
    if (this.state.responseId !== null || text) return this.renderRaw(text, "render");
    return text;
  }

  private async run(
    label: string,
    operation: ChatResponseErrorOperation,
    work: () => Promise<void>,
    extra: () => Record<string, unknown>,
  ): Promise<void> {
    const operationPromise = this.queueTail.then(work);
    const handled = operationPromise.catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.logWarning(`${this.platform.label} ${label} error`, message);
      this.reportResponseError?.(err, operation, extra());
      if (this.platform.notifySendFailure) {
        try {
          await this.platform.notifySendFailure(message);
        } catch {
          // A secondary notification must not poison the response queue.
        }
      }
    });
    this.queueTail = handled.catch(() => undefined);
    return handled;
  }

  private async appendDelta(delta: string): Promise<void> {
    await this.run(
      "appendResponseDelta",
      "respond",
      async () => {
        if (!delta) return;
        if (this.state.resetDelta) {
          this.state.source = "";
          this.state.pendingChars = 0;
          this.state.resetDelta = false;
        }
        const sanitized = this.sanitize(delta);
        this.state.source += sanitized;
        this.state.pendingChars += sanitized.length;
        const elapsed = this.now() - this.state.lastFlushAt;
        if (
          this.state.lastFlushAt === 0 ||
          (elapsed >= this.flushIntervalMs && this.state.pendingChars > 0)
        ) {
          this.state.pendingChars = 0;
          this.state.source = await this.renderDelta(this.state.source);
          this.state.lastFlushAt = this.now();
        }
      },
      () => ({ textLength: delta.length, accumulatedLength: this.state.source.length }),
    );
  }

  private async respond(text: string): Promise<void> {
    await this.run(
      "respond",
      "respond",
      async () => {
        const sanitized = this.sanitize(text);
        this.state.source = this.state.source ? `${this.state.source}\n${sanitized}` : sanitized;
        this.state.pendingChars = 0;
        this.state.source = await this.renderDelta(this.state.source);
        if (this.state.responseId !== null && this.platform.logIntermediateResponses) {
          this.platform.logBotResponse?.(text, this.state.responseId);
        }
      },
      () => ({
        phase: this.state.responseId ? "update" : "initial_post",
        textLength: text.length,
        accumulatedLength: this.state.source.length,
      }),
    );
  }

  private async finishResponse(finalText?: string): Promise<void> {
    await this.run(
      "finishResponse",
      "set_working",
      async () => {
        if (finalText !== undefined) this.state.source = this.sanitize(finalText);
        this.state.resetDelta = false;
        this.state.pendingChars = 0;
        this.stopTyping();
        this.state.working = false;
        this.state.source = await this.renderFinal(this.state.source);
        if (this.state.responseId !== null) {
          this.platform.logBotResponse?.(this.state.source, this.state.responseId);
        }
        await this.platform.onFinish?.(this.state.source, this.state.responseId);
      },
      () => ({ finalTextLength: finalText?.length }),
    );
  }

  private async replaceResponse(
    text: string,
    options?: { createOverflowLink?: () => string },
  ): Promise<void> {
    await this.run(
      "replaceResponse",
      "replace_response",
      async () => {
        this.state.source = this.sanitize(text);
        this.state.pendingChars = 0;
        this.state.resetDelta = true;
        if (this.state.streamActive) await this.stopNativeStream();
        if (this.state.working && !this.state.source.trim()) return;
        const prepared =
          this.platform.prepareSource?.(this.state.source, this.state.working) ?? this.state.source;
        this.state.source = await this.renderRaw(
          this.provisional(prepared, this.state.working),
          "replace",
          options,
          prepared,
        );
      },
      () => ({ textLength: text.length, hadExistingResponse: Boolean(this.state.responseId) }),
    );
  }

  private async replaceSubagentProgress(
    progress: SubagentProgressSnapshot,
    finalText?: string,
  ): Promise<void> {
    const dashboard = this.platform.formatSubagentProgress!(progress);
    await this.responder.replaceResponse(finalText ? `${dashboard}\n\n${finalText}` : dashboard);
  }

  private async respondDiagnostic(
    text: string,
    options: { style?: "muted" | "error" } = {},
  ): Promise<void> {
    await this.run(
      "respondDiagnostic",
      "respond_diagnostic",
      async () => {
        const ids = this.platform.postDiagnostic
          ? await this.platform.postDiagnostic(text, options, this.state.responseId)
          : await this.postDefaultDiagnostic(text, options);
        this.state.extraIds.push(...ids);
      },
      () => ({ textLength: text.length, style: options.style }),
    );
  }

  private async respondToolResult(result: ChatToolResult): Promise<void> {
    await this.responder.respondDiagnostic(this.platform.formatToolResult(result));
  }

  private async setTyping(isTyping: boolean): Promise<void> {
    await this.run(
      "setTyping",
      "set_working",
      async () => {
        if (this.platform.setTyping) {
          await this.platform.setTyping(isTyping, this.state.responseId);
          return;
        }
        const typing = this.platform.typing;
        if (!typing) return;
        const onTypingError = (err: unknown): void => {
          if (this.state.typingFailureWarned) return;
          this.state.typingFailureWarned = true;
          log.logWarning(
            `${this.platform.label} sendTyping failed (further occurrences suppressed for this session)`,
            err instanceof Error ? err.message : String(err),
          );
        };
        if (isTyping && this.state.typingInterval === null) {
          typing.send().catch(onTypingError);
          this.state.typingInterval = setInterval(() => {
            typing.send().catch(onTypingError);
          }, typing.intervalMs);
        } else if (!isTyping) {
          this.stopTyping();
        }
      },
      () => ({ working: isTyping }),
    );
  }

  private async setWorking(working: boolean): Promise<void> {
    await this.run(
      "setWorking",
      "set_working",
      async () => {
        this.state.working = working;
        if (!working) this.stopTyping();
        await this.platform.onWorkingChanged?.(working, this.state.responseId);
        if (
          this.state.responseId === null ||
          (!this.platform.workingIndicator && !this.platform.stream)
        ) {
          return;
        }
        if (working && !this.state.source.trim()) return;
        if (this.state.streamActive && !working) {
          await this.stopNativeStream();
          return;
        }
        if (this.state.responseId !== null) {
          this.state.source = await this.renderRaw(
            this.provisional(this.state.source, working),
            "render",
            undefined,
            this.state.source,
          );
        }
      },
      () => ({ working }),
    );
  }

  private async uploadFile(filePath: string, title?: string): Promise<void> {
    if (this.platform.uploadFile) {
      await this.platform.uploadFile(filePath, title);
      return;
    }
    const note = this.platform.uploadFallbackNote?.(title ?? filePath);
    if (note === undefined) return;
    await this.run(
      "uploadFile",
      "respond_diagnostic",
      () => this.postExtra(note),
      () => ({ filePath }),
    );
  }

  private async deleteResponse(): Promise<void> {
    await this.run(
      "deleteResponse",
      "respond",
      async () => {
        this.stopTyping();
        if (this.state.streamActive) await this.stopNativeStream().catch(() => undefined);
        for (const id of [...this.state.extraIds, ...this.state.continuationIds]) {
          try {
            await this.platform.deleteExtra?.(id);
          } catch {
            // Deleting diagnostics is best effort.
          }
        }
        this.state.extraIds = [];
        this.state.continuationIds = [];
        if (this.state.responseId !== null) {
          try {
            await this.platform.delete?.(this.state.responseId);
          } catch {
            // Deleting the main response is best effort.
          }
        }
        this.state.responseId = null;
        this.state.source = "";
        this.state.streamUnavailable = false;
        this.state.streamedSource = "";
        this.state.streamActive = false;
        this.state.resetDelta = false;
        this.state.working = true;
      },
      () => ({}),
    );
  }

  private async postDefaultDiagnostic(
    text: string,
    options: { style?: "muted" | "error" },
  ): Promise<Array<string | number>> {
    const prefix = options.style === "error" ? this.platform.errorPrefix : "";
    const ids: Array<string | number> = [];
    for (const part of this.split(this.sanitize(`${prefix}${text}`))) {
      const id = await this.platform.postExtra(part, this.state.responseId);
      if (typeof id === "string" || typeof id === "number") ids.push(id);
    }
    return ids;
  }
}

export function createProgressiveRenderer(platform: ProgressiveRendererPlatform): {
  responder: ConversationResponder;
} {
  return { responder: new ProgressiveRenderer(platform).responder };
}
