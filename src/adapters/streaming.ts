export type { BufferedResponseStreamOptions, BufferedResponseStreamSink } from "./types.js";
import type { BufferedResponseStreamOptions, BufferedResponseStreamSink } from "./types.js";

export class BufferedResponseStream {
  private readonly minFlushIntervalMs: number;
  private readonly minFlushChars: number;
  private readonly now: () => number;
  private readonly sink: BufferedResponseStreamSink;
  private text = "";
  private pendingChars = 0;
  private lastFlushAt = 0;

  constructor(sink: BufferedResponseStreamSink, options: BufferedResponseStreamOptions = {}) {
    this.sink = sink;
    this.minFlushIntervalMs = options.minFlushIntervalMs ?? 750;
    this.minFlushChars = options.minFlushChars ?? 80;
    this.now = options.now ?? Date.now;
  }

  getText(): string {
    return this.text;
  }

  setText(text: string): void {
    this.text = text;
    this.pendingChars = 0;
  }

  async append(delta: string): Promise<void> {
    if (!delta) return;
    this.text += delta;
    this.pendingChars += delta.length;

    const elapsed = this.now() - this.lastFlushAt;
    if (
      this.lastFlushAt === 0 ||
      this.pendingChars >= this.minFlushChars ||
      elapsed >= this.minFlushIntervalMs
    ) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    this.pendingChars = 0;
    this.lastFlushAt = this.now();
    await this.sink.flush(this.text);
  }

  async finish(finalText?: string): Promise<void> {
    if (finalText !== undefined) {
      this.text = finalText;
    }
    this.pendingChars = 0;
    this.lastFlushAt = this.now();
    await this.sink.finish(this.text);
  }
}
