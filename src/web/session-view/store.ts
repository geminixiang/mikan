import type { PlatformName } from "../../adapter.js";
import { InMemoryTokenStore } from "../token-store.js";

export interface SessionViewToken {
  token: string;
  platform: PlatformName;
  platformUserId: string;
  platformUserName?: string;
  conversationId: string;
  sessionKey: string;
  sessionFile: string;
  expiresAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;

export class InMemorySessionViewTokenStore extends InMemoryTokenStore<SessionViewToken> {
  create(
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
    sessionKey: string,
    sessionFile: string,
    platformUserName?: string,
  ): SessionViewToken {
    const { token, expiresAt } = this.mintToken(TTL_MS);
    const record: SessionViewToken = {
      token,
      platform,
      platformUserId,
      ...(platformUserName ? { platformUserName } : {}),
      conversationId,
      sessionKey,
      sessionFile,
      expiresAt,
    };
    this.tokens.set(token, record);
    return record;
  }
}
