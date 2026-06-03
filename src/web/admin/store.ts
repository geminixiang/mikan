import type { PlatformName } from "../../adapter.js";
import { InMemoryTokenStore } from "../token-store.js";

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

export class InMemoryAdminTokenStore extends InMemoryTokenStore<AdminToken> {
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

    const { token, expiresAt } = this.mintToken(TTL_MS);
    const record: AdminToken = {
      token,
      platform: args.platform,
      platformUserId: args.platformUserId,
      ...(args.platformUserName ? { platformUserName: args.platformUserName } : {}),
      conversationId: args.conversationId,
      expiresAt,
    };
    this.tokens.set(token, record);
    return record;
  }
}
