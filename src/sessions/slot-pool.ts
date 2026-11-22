export class SlotPool {
  private taken = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly size: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.taken >= this.size) await this.wait(signal);
    this.taken += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.taken -= 1;
      this.waiting.shift()?.();
    };
  }

  private wait(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const admit = () => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        this.waiting.splice(this.waiting.indexOf(admit), 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.waiting.push(admit);
    });
  }
}
