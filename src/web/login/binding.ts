import type { PlatformName } from "../../adapter.js";
import { InMemoryTokenStore } from "../token-store.js";
import type { TokenRecord } from "../types.js";

/** A 5-minute binding code that proves the user is in a platform conversation. */
export interface BindingToken extends TokenRecord {
  platform: PlatformName;
  platformUserId: string;
  conversationId: string;
}

/** 6-character alphanumeric binding code (no I,O,0,1 to avoid confusion). */
function generateBindingCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

const BINDING_TTL_MS = 5 * 60 * 1000;

export class InMemoryBindingTokenStore extends InMemoryTokenStore<BindingToken> {
  create(
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
  ): { code: string; token: BindingToken } {
    // Clean up any existing binding for this platform user
    this.deleteWhere(
      (token) => token.platform === platform && token.platformUserId === platformUserId,
    );
    const code = generateBindingCode();
    const token = this.createRecord(BINDING_TTL_MS, { platform, platformUserId, conversationId });
    // Store the code as an additional key pointing at the same record
    this.tokens.set(code, token);
    return { code, token };
  }

  /**
   * Look up a binding by its 6-character code. The code is consumed
   * atomically (removed) on success. Returns undefined for invalid/expired
   * codes.
   */
  consumeByCode(code: string): BindingToken | undefined {
    const record = this.tokens.get(code);
    if (!record) return undefined;
    if (Date.now() > record.expiresAt) {
      this.tokens.delete(code);
      return undefined;
    }
    this.tokens.delete(code);
    return record;
  }
}
