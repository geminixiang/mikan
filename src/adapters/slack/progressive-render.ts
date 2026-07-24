import * as log from "../../log.js";
import { renderSlackBlocks } from "./blocks.js";

export const WORKING_INDICATOR = " ...";

/**
 * The platform operations the progressive renderer drives. SlackMessagingBot
 * satisfies this in production; tests satisfy it with an in-memory fake.
 */
export interface SlackRenderOps {
  postMessage(channel: string, text: string): Promise<string>;
  postInThread(channel: string, threadTs: string, text: string): Promise<string>;
  updateMessage(channel: string, ts: string, text: string): Promise<void>;
  startMessageStream(
    channel: string,
    text: string,
    threadTs?: string,
    recipientUserId?: string,
  ): Promise<string>;
  appendMessageStream(channel: string, ts: string, text: string): Promise<void>;
  stopMessageStream(channel: string, ts: string): Promise<void>;
}

export interface ProgressiveRenderTarget {
  channelId: string;
  rootTs?: string | null;
  replyInThread: boolean;
  recipientUserId?: string;
  initialMessageTs?: string | null;
}

/** Close an unterminated fenced code block so a provisional (mid-stream)
 *  render doesn't swallow the rest of the message into the fence. */
export function closeOpenFences(text: string): string {
  let openMarker: string | null = null;
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (!match) continue;
    if (openMarker === null) openMarker = match[1];
    else if (match[1][0] === openMarker[0] && match[1].length >= openMarker.length)
      openMarker = null;
  }
  return openMarker ? `${text}\n${openMarker}` : text;
}

/** True when the canonical Block Kit rendering contains structure the native
 *  markdown_text stream cannot express (today: tables). */
function needsCanonicalRender(text: string): boolean {
  return renderSlackBlocks(text).blocks.some((block) => block.type === "table");
}

/**
 * Progressive renderer for one Slack response message.
 *
 * Owns how accumulated response-source markdown becomes a visible Slack
 * message over time: native markdown_text streaming when the reply lives in a
 * thread, markdown-block chat.update otherwise, and the switch between them
 * when a stream dies or the text stops extending. Callers never learn which
 * engine is active.
 *
 * msg_too_long is NOT handled here — it propagates so the response lifecycle
 * can run its truncation fallback via write().
 */
export class SlackProgressiveRender {
  private readonly channelId: string;
  private readonly rootTs: string | null;
  private readonly replyInThread: boolean;
  private readonly recipientUserId: string | undefined;
  private ts: string | null;
  private streamActive = false;
  private streamUnavailable = false;
  private streamedText = "";

  constructor(
    private readonly ops: SlackRenderOps,
    target: ProgressiveRenderTarget,
  ) {
    this.channelId = target.channelId;
    this.rootTs = target.rootTs ?? null;
    this.replyInThread = target.replyInThread;
    this.recipientUserId = target.recipientUserId;
    this.ts = target.initialMessageTs ?? null;
  }

  get messageTs(): string | null {
    return this.ts;
  }

  /** Forget the message (after external deletion). */
  clearMessage(): void {
    this.ts = null;
    this.streamActive = false;
    this.streamedText = "";
  }

  /** Raw canonical write: update the message, or create it. No streaming, no
   *  provisional decoration. The lifecycle's msg_too_long fallback drives this. */
  async write(text: string): Promise<void> {
    if (this.ts) {
      await this.ops.updateMessage(this.channelId, this.ts, text);
      return;
    }
    if (this.replyInThread && this.rootTs) {
      this.ts = await this.ops.postInThread(this.channelId, this.rootTs, text);
      return;
    }
    this.ts = await this.ops.postMessage(this.channelId, text);
  }

  private provisional(text: string, working: boolean): string {
    const closed = closeOpenFences(text);
    return working ? closed + WORKING_INDICATOR : closed;
  }

  private async abandonStream(): Promise<void> {
    if (!this.ts) return;
    const failedTs = this.ts;
    this.streamActive = false;
    this.streamedText = "";
    await this.ops.stopMessageStream(this.channelId, failedTs).catch(() => undefined);
    if (this.ts === failedTs) this.ts = null;
  }

  private markStreamUnavailable(err: unknown): void {
    this.streamUnavailable = true;
    log.logWarning(
      "Slack streaming unavailable; falling back to chat.update",
      err instanceof Error ? err.message : String(err),
    );
  }

  /** Provisional render of the accumulated text (a flush mid-response). */
  async delta(text: string, working: boolean): Promise<void> {
    if (this.streamUnavailable) return this.write(this.provisional(text, working));
    if (this.ts && !this.streamActive) return this.write(this.provisional(text, working));
    if (this.ts && this.streamActive && !text.startsWith(this.streamedText)) {
      await this.abandonStream();
      return this.write(this.provisional(text, working));
    }
    if (!this.ts && (!this.replyInThread || !this.rootTs)) {
      this.streamUnavailable = true;
      return this.write(this.provisional(text, working));
    }

    try {
      if (this.ts) {
        const delta = text.slice(this.streamedText.length);
        if (delta) {
          await this.ops.appendMessageStream(this.channelId, this.ts, delta);
          this.streamedText = text;
        }
        return;
      }
      this.ts = await this.ops.startMessageStream(
        this.channelId,
        text,
        this.rootTs ?? undefined,
        this.recipientUserId,
      );
      this.streamActive = true;
      this.streamedText = text;
    } catch (err) {
      this.markStreamUnavailable(err);
      await this.abandonStream();
      await this.write(this.provisional(text, working));
    }
  }

  /** Final render. Ends an active stream; re-renders canonically only when the
   *  stream could not express the content (tables). */
  async finish(text: string): Promise<void> {
    if (this.streamActive && this.ts) {
      let streamed = false;
      try {
        if (text.startsWith(this.streamedText)) {
          const delta = text.slice(this.streamedText.length);
          if (delta) await this.ops.appendMessageStream(this.channelId, this.ts, delta);
          await this.ops.stopMessageStream(this.channelId, this.ts);
          streamed = true;
        }
      } catch (err) {
        this.markStreamUnavailable(err);
      }
      this.streamActive = false;
      this.streamedText = "";
      if (streamed) {
        if (needsCanonicalRender(text)) await this.write(text);
        return;
      }
      await this.abandonStream();
    }
    if (this.ts || text) await this.write(text);
  }

  /** Non-append rewrite of the whole message, keeping its identity. */
  async replace(text: string, working: boolean): Promise<void> {
    if (this.streamActive && this.ts) {
      await this.ops.stopMessageStream(this.channelId, this.ts);
      this.streamActive = false;
      this.streamedText = "";
    }
    await this.write(this.provisional(text, working));
  }

  /** Reflect the working indicator; ends the stream when work stops. */
  async setWorking(text: string, working: boolean): Promise<void> {
    if (!this.ts) return;
    if (this.streamActive && !working) {
      await this.ops.stopMessageStream(this.channelId, this.ts);
      this.streamActive = false;
      return;
    }
    await this.ops.updateMessage(this.channelId, this.ts, this.provisional(text, working));
  }
}
