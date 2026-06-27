import { randomBytes } from "crypto";
export type { TokenRecord } from "./types.js";
import type { TokenRecord } from "./types.js";

export class InMemoryTokenStore<T extends TokenRecord> {
  protected readonly tokens = new Map<string, T>();

  protected createRecord(ttlMs: number, data: Omit<T, keyof TokenRecord>): T {
    const token = randomBytes(16).toString("hex");
    const record = { ...data, token, expiresAt: Date.now() + ttlMs } as T;
    this.tokens.set(token, record);
    return record;
  }

  protected deleteWhere(predicate: (record: T) => boolean): void {
    for (const [key, record] of this.tokens) {
      if (predicate(record)) this.tokens.delete(key);
    }
  }

  peek(rawToken: string): T | undefined {
    const entry = this.tokens.get(rawToken);
    if (!entry || Date.now() > entry.expiresAt) return undefined;
    return entry;
  }

  /** One-shot consume. Returns undefined if missing or expired. */
  consume(rawToken: string): T | undefined {
    const entry = this.tokens.get(rawToken);
    if (!entry) return undefined;
    this.tokens.delete(rawToken);
    if (Date.now() > entry.expiresAt) return undefined;
    return entry;
  }

  /** Remove expired tokens. Call periodically to bound memory usage. */
  purge(): void {
    const now = Date.now();
    for (const [key, t] of this.tokens) {
      if (now > t.expiresAt) {
        this.tokens.delete(key);
      }
    }
  }
}
