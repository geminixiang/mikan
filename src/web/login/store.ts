import { randomBytes } from "crypto";
import type { PlatformName } from "../../adapter.js";

export interface LinkToken {
  token: string;
  platform: PlatformName;
  platformUserId: string;
  vaultId: string;
  providerId: string;
  /** Conversation to notify when binding completes */
  conversationId: string;
  expiresAt: number;
}

const TTL_MS = 15 * 60 * 1000;

export class InMemoryLinkTokenStore {
  private tokens = new Map<string, LinkToken>();

  /**
   * Create a link token for a platform user.
   * Invalidates any existing token for the same user before creating a new one.
   */
  create(
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
    vaultId: string,
    providerId: string,
  ): LinkToken {
    for (const [key, t] of this.tokens) {
      if (t.platform === platform && t.platformUserId === platformUserId) {
        this.tokens.delete(key);
      }
    }

    const token: LinkToken = {
      token: randomBytes(16).toString("hex"),
      platform,
      platformUserId,
      vaultId,
      providerId,
      conversationId,
      expiresAt: Date.now() + TTL_MS,
    };
    this.tokens.set(token.token, token);
    return token;
  }

  /** Look up a token without consuming it. Returns undefined if missing or expired. */
  peek(rawToken: string): LinkToken | undefined {
    const entry = this.tokens.get(rawToken);
    if (!entry || Date.now() > entry.expiresAt) return undefined;
    return entry;
  }

  /** Consume a token (one-shot). Returns undefined if missing or expired. */
  consume(rawToken: string): LinkToken | undefined {
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
