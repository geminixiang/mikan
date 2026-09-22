const MAX_STREAM_STARTS_PER_WINDOW = 15;
const WINDOW_MS = 60_000;

export class StreamStartLimiter {
  private starts: number[] = [];

  constructor(
    private readonly limit: number = MAX_STREAM_STARTS_PER_WINDOW,
    private readonly windowMs: number = WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  tryReserve(): boolean {
    const cutoff = this.now() - this.windowMs;
    this.starts = this.starts.filter((at) => at > cutoff);
    if (this.starts.length >= this.limit) return false;
    this.starts.push(this.now());
    return true;
  }

  get used(): number {
    return this.starts.filter((at) => at > this.now() - this.windowMs).length;
  }
}
