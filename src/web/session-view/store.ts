import type { PlatformName } from "../../adapter.js";
import { InMemoryTokenStore } from "../token-store.js";
export type { SessionViewToken } from "./types.js";
import type { SessionViewToken } from "./types.js";

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
    return this.createRecord(TTL_MS, {
      platform,
      platformUserId,
      ...(platformUserName ? { platformUserName } : {}),
      conversationId,
      sessionKey,
      sessionFile,
    });
  }
}
