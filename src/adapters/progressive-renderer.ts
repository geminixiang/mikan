import type {
  ChatToolResult,
  ConversationResponder,
  ReplaceResponseOptions,
  SubagentProgressSnapshot,
} from "../types.js";
import * as log from "../log.js";
import { createChatResponseErrorReporter, splitText } from "./shared.js";
import type { ChatResponseErrorOperation, ProgressiveRendererPlatform } from "./types.js";
import { formatToolArgs } from "../harness/tool-args.js";
import { errorMessage } from "../unknown-values.js";

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
  typingInterval: ReturnType<typeof setInterval> | null;
  typingFailureWarned: boolean;
  extraIds: Array<string | number>;
  continuationIds: Array<string | number>;
  shown: string | null;
  lastWriteAt: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

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
      typingInterval: null,
      typingFailureWarned: false,
      extraIds: [],
      continuationIds: [],
      shown: null,
      lastWriteAt: 0,
      flushTimer: null,
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
      showsPartialAnswer: Boolean(this.platform.showsPartialAnswer || this.platform.stream),
      replaceResponse: (text, options) => this.replaceResponse(text, options),
      replaceSubagentProgress: this.platform.formatSubagentProgress
        ? (progress, finalText, options) =>
            this.replaceSubagentProgress(progress, finalText, options)
        : undefined,
      respondDiagnostic: (text, options) => this.respondDiagnostic(text, options),
      respondToolResult: (result) => this.respondToolResult(result),
      setTyping: (isTyping) => this.setTyping(isTyping),
      setWorking: (working) => this.setWorking(working),
      uploadFile: (filePath, title) => this.uploadFile(filePath, title),
      react: this.platform.react,
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

  private async renderFinal(text: string, options?: ReplaceResponseOptions): Promise<string> {
    const stream = this.platform.stream;
    if (stream && this.state.streamActive && this.state.responseId !== null) {
      const streamId = this.state.responseId;
      const extendsStream = text.startsWith(this.state.streamedSource);
      this.state.streamActive = false;
      try {
        if (extendsStream) {
          const delta = text.slice(this.state.streamedSource.length);
          if (delta) await stream.append(streamId, delta);
        }
        await stream.stop(streamId);
      } catch (err) {
        this.state.streamUnavailable = true;
        log.logWarning(
          "Native response streaming unavailable; falling back to message updates",
          errorMessage(err),
        );
        await stream.stop(streamId).catch(() => undefined);
        return this.renderRaw(text, "replace", options);
      } finally {
        this.state.streamedSource = "";
      }
      if (extendsStream && !this.platform.needsCanonicalRender?.(text)) return text;
      return this.renderRaw(text, "replace", options);
    }
    if (text === this.state.shown) return text;
    if (this.state.responseId !== null || text) return this.renderRaw(text, "replace", options);
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
      const message = errorMessage(err);
      log.logWarning(`${this.platform.label} ${label} error`, message);
      this.reportResponseError?.(err, operation, extra());
      if (this.platform.notifySendFailure) {
        try {
          await this.platform.notifySendFailure(message);
        } catch {}
      }
      if (label === "finalResponse") throw err;
    });
    this.queueTail = handled.catch(() => undefined);
    return handled;
  }

  private async respond(text: string): Promise<void> {
    await this.run(
      "respond",
      "respond",
      async () => {
        const sanitized = this.sanitize(text);
        this.state.source = this.state.source ? `${this.state.source}\n${sanitized}` : sanitized;
        this.cancelFlush();
        await this.renderView();
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

  private async replaceResponse(text: string, options?: ReplaceResponseOptions): Promise<void> {
    await this.run(
      options?.final ? "finalResponse" : "replaceResponse",
      "replace_response",
      async () => {
        this.state.source = this.sanitize(text);
        if (options?.final) await this.finish(options);
        else await this.show(options);
      },
      () => ({
        textLength: text.length,
        hadExistingResponse: Boolean(this.state.responseId),
        final: options?.final === true,
      }),
    );
  }

  private async show(options?: ReplaceResponseOptions): Promise<void> {
    if (this.state.working && !this.state.source.trim()) return;
    const wait = this.state.lastWriteAt + this.flushIntervalMs - this.now();
    if (this.state.working && wait > 0) {
      this.scheduleFlush(wait);
      return;
    }
    await this.renderView(options);
  }

  private async finish(options: ReplaceResponseOptions): Promise<void> {
    this.stopTyping();
    this.cancelFlush();
    this.state.working = false;
    this.state.source = await this.renderFinal(this.state.source, options);
    this.state.shown = this.state.source;
    this.state.lastWriteAt = this.now();
    if (this.state.responseId !== null) {
      this.platform.logBotResponse?.(this.state.source, this.state.responseId);
    }
    await this.platform.onFinish?.(this.state.source, this.state.responseId);
  }

  private scheduleFlush(delayMs: number): void {
    if (this.state.flushTimer !== null) return;
    this.state.flushTimer = setTimeout(() => {
      this.state.flushTimer = null;
      void this.run(
        "flushResponse",
        "replace_response",
        () => this.renderView(),
        () => ({ deferred: true }),
      );
    }, delayMs);
    this.state.flushTimer.unref?.();
  }

  private cancelFlush(): void {
    if (this.state.flushTimer === null) return;
    clearTimeout(this.state.flushTimer);
    this.state.flushTimer = null;
  }

  private async renderView(options?: ReplaceResponseOptions): Promise<void> {
    if (this.state.working && !this.state.source.trim()) return;
    const prepared =
      this.platform.prepareSource?.(this.state.source, this.state.working) ?? this.state.source;
    const display = this.provisional(prepared, this.state.working);
    if (display === this.state.shown) return;
    try {
      await this.writeView(prepared, display, options);
    } finally {
      this.state.lastWriteAt = this.now();
    }
    this.state.shown = display;
  }

  private async writeView(
    prepared: string,
    display: string,
    options: ReplaceResponseOptions | undefined,
  ): Promise<void> {
    const stream = this.platform.stream;
    const canStream =
      stream !== undefined &&
      this.state.working &&
      !this.state.streamUnavailable &&
      (this.state.responseId === null ||
        (this.state.streamActive && prepared.startsWith(this.state.streamedSource)));
    try {
      if (canStream && this.state.responseId === null) {
        this.state.responseId = await stream.start(prepared);
        this.state.streamActive = true;
        this.state.streamedSource = prepared;
      } else if (canStream && this.state.responseId !== null) {
        const delta = prepared.slice(this.state.streamedSource.length);
        if (delta) await stream.append(this.state.responseId, delta);
        this.state.streamedSource = prepared;
      } else {
        if (this.state.streamActive) await this.stopNativeStream();
        await this.renderRaw(display, "render", options, prepared);
      }
    } catch (err) {
      if (!canStream) throw err;
      this.state.streamUnavailable = true;
      log.logWarning(
        "Native response streaming unavailable; falling back to message updates",
        errorMessage(err),
      );
      if (this.state.streamActive) await this.stopNativeStream().catch(() => undefined);
      await this.renderRaw(display, "render", options, prepared);
    }
  }

  private async replaceSubagentProgress(
    progress: SubagentProgressSnapshot,
    finalText?: string,
    options?: ReplaceResponseOptions,
  ): Promise<void> {
    const dashboard = this.platform.formatSubagentProgress!(progress);
    await this.responder.replaceResponse(
      finalText ? `${dashboard}\n\n${finalText}` : dashboard,
      options,
    );
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
            errorMessage(err),
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
        if (!working) {
          this.stopTyping();
          this.cancelFlush();
        }
        await this.platform.onWorkingChanged?.(working, this.state.responseId);
        if (this.state.responseId === null) return;
        if (!working && this.state.streamActive) await this.stopNativeStream();
        await this.renderView();
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
        this.cancelFlush();
        this.state.shown = null;
        if (this.state.streamActive) await this.stopNativeStream().catch(() => undefined);
        for (const id of [...this.state.extraIds, ...this.state.continuationIds]) {
          try {
            await this.platform.deleteExtra?.(id);
          } catch {}
        }
        this.state.extraIds = [];
        this.state.continuationIds = [];
        if (this.state.responseId !== null) {
          try {
            await this.platform.delete?.(this.state.responseId);
          } catch {}
        }
        this.state.responseId = null;
        this.state.source = "";
        this.state.streamUnavailable = false;
        this.state.streamedSource = "";
        this.state.streamActive = false;
        this.state.lastWriteAt = 0;
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
