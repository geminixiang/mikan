import { randomBytes } from "crypto";
import type { PlatformName } from "../adapter.js";

export interface AdminToken {
  token: string;
  platform: PlatformName;
  platformUserId: string;
  platformUserName?: string;
  /** The conversation where /admin was invoked. Default scope for the 3 sub-pages. */
  conversationId: string;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000;

export class InMemoryAdminTokenStore {
  private tokens = new Map<string, AdminToken>();

  create(args: {
    platform: PlatformName;
    platformUserId: string;
    conversationId: string;
    platformUserName?: string;
  }): AdminToken {
    for (const [key, t] of this.tokens) {
      if (t.platform === args.platform && t.platformUserId === args.platformUserId) {
        this.tokens.delete(key);
      }
    }

    const token: AdminToken = {
      token: randomBytes(16).toString("hex"),
      platform: args.platform,
      platformUserId: args.platformUserId,
      ...(args.platformUserName ? { platformUserName: args.platformUserName } : {}),
      conversationId: args.conversationId,
      expiresAt: Date.now() + TTL_MS,
    };
    this.tokens.set(token.token, token);
    return token;
  }

  peek(rawToken: string): AdminToken | undefined {
    const entry = this.tokens.get(rawToken);
    if (!entry || Date.now() > entry.expiresAt) return undefined;
    return entry;
  }

  purge(): void {
    const now = Date.now();
    for (const [key, t] of this.tokens) {
      if (now > t.expiresAt) {
        this.tokens.delete(key);
      }
    }
  }
}
