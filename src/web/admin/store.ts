import type { PlatformName } from "../../adapter.js";
import { InMemoryTokenStore } from "../token-store.js";
export type { AdminToken } from "./types.js";
import type { AdminToken } from "./types.js";

const TTL_MS = 30 * 60 * 1000;

export class InMemoryAdminTokenStore extends InMemoryTokenStore<AdminToken> {
  create(args: {
    platform: PlatformName;
    platformUserId: string;
    conversationId: string;
    platformUserName?: string;
  }): AdminToken {
    this.deleteWhere(
      (token) => token.platform === args.platform && token.platformUserId === args.platformUserId,
    );
    return this.createRecord(TTL_MS, {
      platform: args.platform,
      platformUserId: args.platformUserId,
      ...(args.platformUserName ? { platformUserName: args.platformUserName } : {}),
      conversationId: args.conversationId,
    });
  }
}
