import type { PlatformName } from "../../adapter.js";
import { InMemoryTokenStore } from "../token-store.js";
import type { TokenRecord } from "../types.js";

/** A 5-minute binding code that proves the user is in a platform conversation. */
export interface BindingToken extends TokenRecord {
  platform: PlatformName;
  platformUserId: string;
  conversationId: string;
}

/** A completed binding: OAuth identity → platform identity. */
export interface CompletedBinding {
  oauthIdentity: string;
  platform: PlatformName;
  platformUserId: string;
  conversationId: string;
  createdAt: number;
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
  private readonly completed = new Map<string, CompletedBinding>();

  create(
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
  ): { code: string; token: BindingToken } {
    this.deleteWhere(
      (token) => token.platform === platform && token.platformUserId === platformUserId,
    );
    const code = generateBindingCode();
    const token = this.createRecord(BINDING_TTL_MS, { platform, platformUserId, conversationId });
    this.tokens.set(code, token);
    return { code, token };
  }

  /** Look up a binding code without consuming it (for the binding page). */
  override peek(code: string): BindingToken | undefined {
    return this.tokens.get(code);
  }

  /**
   * Look up a binding by its 6-character code. The code is consumed
   * atomically on success. Returns undefined for invalid/expired codes.
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

  /**
   * Record a completed binding: OAuth identity → platform identity.
   */
  bind(
    oauthIdentity: string,
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
  ): CompletedBinding {
    const binding: CompletedBinding = {
      oauthIdentity,
      platform,
      platformUserId,
      conversationId,
      createdAt: Date.now(),
    };
    this.completed.set(`oauth:${oauthIdentity}`, binding);
    this.completed.set(`platform:${platform}:${platformUserId}`, binding);
    return binding;
  }

  /** Look up the platform identity for an OAuth identity. */
  resolveByOAuthIdentity(oauthIdentity: string): CompletedBinding | undefined {
    return this.completed.get(`oauth:${oauthIdentity}`);
  }
}
