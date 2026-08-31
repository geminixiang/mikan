/**
 * How many native response streams we are willing to open per minute.
 *
 * `chat.startStream` and `chat.stopStream` sit in a much tighter rate tier
 * than `chat.postMessage`, and every streamed reply spends one of each — so
 * the binding constraint is the number of *streams started*, not the number
 * of tokens appended. A workspace answering a burst of mentions, or an
 * process firing a batch of scheduled runs, reaches that ceiling long
 * before it reaches any posting limit.
 *
 * Exceeding it is not fatal — the renderer catches the failure and falls back
 * to edit-based updates — but it costs a wasted request, a warning line, and
 * a visibly worse first response. Declining to start a stream *before*
 * spending the request converts that into a silent, deliberate downgrade.
 *
 * The reservation is per process, which is the same grain as the connection
 * to Slack. Two mikan instances on one workspace would each keep their own
 * count; that is a deployment mistake with worse symptoms than rate limiting
 * (duplicate replies), so it is not defended against here.
 */

/**
 * Conservative: the published tier is a floor rather than a ceiling, and
 * leaving headroom means an unlucky burst degrades gracefully instead of
 * discovering the real limit. Streams are a presentation nicety — the reply
 * still arrives without one.
 */
const MAX_STREAM_STARTS_PER_WINDOW = 15;
const WINDOW_MS = 60_000;

export class StreamStartLimiter {
  private starts: number[] = [];

  constructor(
    private readonly limit: number = MAX_STREAM_STARTS_PER_WINDOW,
    private readonly windowMs: number = WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Claim one stream start, or refuse. Refusing is the caller's signal to use
   * the non-streaming path; it is not an error.
   */
  tryReserve(): boolean {
    const cutoff = this.now() - this.windowMs;
    // Rolling window rather than fixed buckets: a fixed bucket lets twice the
    // limit through across a boundary, which is exactly the burst shape this
    // exists to survive.
    this.starts = this.starts.filter((at) => at > cutoff);
    if (this.starts.length >= this.limit) return false;
    this.starts.push(this.now());
    return true;
  }

  /** Streams started inside the current window, for diagnostics. */
  get used(): number {
    return this.starts.filter((at) => at > this.now() - this.windowMs).length;
  }
}
