import { randomBytes } from "crypto";
export type { TokenRecord } from "./types.js";
import type { TokenRecord } from "./types.js";

/**
 * Generic in-memory TTL token store.
 *
 * Subclasses call `mintToken(ttlMs)` to create a new token string and
 * expiry, then assemble the full record. The base class provides `peek`,
 * `consume`, and `purge`.
 */
export class InMemoryTokenStore<T extends TokenRecord> {
  protected readonly tokens = new Map<string, T>();

  protected mintToken(ttlMs: number): Pick<TokenRecord, "token" | "expiresAt"> {
    return {
      token: randomBytes(16).toString("hex"),
      expiresAt: Date.now() + ttlMs,
    };
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
