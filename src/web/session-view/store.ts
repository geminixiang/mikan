import type { OfficeAddress } from "../../adapter.js";
import { InMemoryTokenStore } from "../token-store.js";
export type { SessionViewToken } from "./types.js";
import type { SessionViewToken } from "./types.js";

const TTL_MS = 24 * 60 * 60 * 1000;

export class InMemorySessionViewTokenStore extends InMemoryTokenStore<SessionViewToken> {
  create(args: {
    address: OfficeAddress;
    platformUserId: string;
    sessionId: string;
    platformUserName?: string;
  }): SessionViewToken {
    return this.createRecord(TTL_MS, {
      address: args.address,
      platformUserId: args.platformUserId,
      ...(args.platformUserName ? { platformUserName: args.platformUserName } : {}),
      sessionId: args.sessionId,
    });
  }
}
