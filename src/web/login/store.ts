import type { PlatformName } from "../../adapter.js";
import { InMemoryTokenStore } from "../token-store.js";

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

export class InMemoryLinkTokenStore extends InMemoryTokenStore<LinkToken> {
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

    const { token, expiresAt } = this.mintToken(TTL_MS);
    const record: LinkToken = {
      token,
      platform,
      platformUserId,
      vaultId,
      providerId,
      conversationId,
      expiresAt,
    };
    this.tokens.set(token, record);
    return record;
  }
}
