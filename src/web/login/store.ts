import type { PlatformName } from "../../adapter.js";
import { InMemoryTokenStore } from "../token-store.js";
export type { LinkToken } from "./types.js";
import type { LinkToken } from "./types.js";

const TTL_MS = 15 * 60 * 1000;

export class InMemoryLinkTokenStore extends InMemoryTokenStore<LinkToken> {
  create(
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
    vaultId: string,
    providerId: string,
  ): LinkToken {
    this.deleteWhere(
      (token) => token.platform === platform && token.platformUserId === platformUserId,
    );
    return this.createRecord(TTL_MS, {
      platform,
      platformUserId,
      vaultId,
      providerId,
      conversationId,
    });
  }
}
