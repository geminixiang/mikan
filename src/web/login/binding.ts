import { dirname, join } from "node:path";
import type { PlatformName } from "../../adapter.js";
import {
  ensureDirExists,
  readJsonFileIfExists,
  atomicWritePrivateFile,
} from "../../utils/file-guards.js";
import { InMemoryTokenStore } from "../token-store.js";
export type { BindingToken, CompletedBinding } from "./types.js";
import type { BindingToken, CompletedBinding, OAuthPrincipal } from "./types.js";

interface CompletedBindingFile {
  version: 1;
  bindings: CompletedBinding[];
}

const BINDING_TTL_MS = 5 * 60 * 1000;
const COMPLETED_BINDINGS_FILENAME = "web-bindings.json";

/** 6-character alphanumeric binding code (no I,O,0,1 to avoid confusion). */
function generateBindingCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Pending proof codes stay in memory; completed OAuth admission bindings are
 * persisted when a State dir is supplied so daemon restarts do not require a
 * new chat-side `/login web` ceremony.
 */
export class WebBindingStore extends InMemoryTokenStore<BindingToken> {
  private readonly completedByOAuth = new Map<string, CompletedBinding>();
  private readonly completedByPlatform = new Map<string, CompletedBinding>();
  private readonly completedPath: string | undefined;

  constructor(stateDir?: string) {
    super();
    this.completedPath = stateDir ? join(stateDir, COMPLETED_BINDINGS_FILENAME) : undefined;
    this.loadCompleted();
  }

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

  override peek(code: string): BindingToken | undefined {
    return this.tokens.get(code);
  }

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

  bind(
    principal: OAuthPrincipal,
    platform: PlatformName,
    platformUserId: string,
    conversationId: string,
  ): CompletedBinding {
    const binding: CompletedBinding = {
      oauthIdentity: principal.id,
      oauthDisplayName: principal.displayName,
      platform,
      platformUserId,
      conversationId,
      createdAt: Date.now(),
    };
    this.removeCompleted(this.completedByOAuth.get(principal.id));
    this.removeCompleted(this.completedByPlatform.get(platformIdentity(platform, platformUserId)));
    this.completedByOAuth.set(principal.id, binding);
    this.completedByPlatform.set(platformIdentity(platform, platformUserId), binding);
    this.persistCompleted();
    return binding;
  }

  resolveByOAuthIdentity(oauthIdentity: string): CompletedBinding | undefined {
    return this.completedByOAuth.get(oauthIdentity);
  }

  private removeCompleted(binding: CompletedBinding | undefined): void {
    if (!binding) return;
    this.completedByOAuth.delete(binding.oauthIdentity);
    this.completedByPlatform.delete(platformIdentity(binding.platform, binding.platformUserId));
  }

  private loadCompleted(): void {
    const path = this.completedPath;
    if (!path) return;
    const file = readJsonFileIfExists(
      path,
      isCompletedBindingFile,
      (detail) => `Invalid completed web binding store ${path}: ${detail}`,
    );
    for (const binding of file?.bindings ?? []) {
      this.completedByOAuth.set(binding.oauthIdentity, binding);
      this.completedByPlatform.set(
        platformIdentity(binding.platform, binding.platformUserId),
        binding,
      );
    }
  }

  private persistCompleted(): void {
    const path = this.completedPath;
    if (!path) return;
    ensureDirExists(dirname(path));
    const file: CompletedBindingFile = {
      version: 1,
      bindings: [...this.completedByOAuth.values()].toSorted(
        (left, right) => left.createdAt - right.createdAt,
      ),
    };
    atomicWritePrivateFile(path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

function platformIdentity(platform: PlatformName, platformUserId: string): string {
  return `${platform}:${platformUserId}`;
}

function isCompletedBindingFile(value: unknown): value is CompletedBindingFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.bindings)) return false;
  return value.bindings.every(isCompletedBinding);
}

function isCompletedBinding(value: unknown): value is CompletedBinding {
  return (
    isRecord(value) &&
    typeof value.oauthIdentity === "string" &&
    typeof value.oauthDisplayName === "string" &&
    isPlatformName(value.platform) &&
    typeof value.platformUserId === "string" &&
    typeof value.conversationId === "string" &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt)
  );
}

function isPlatformName(value: unknown): value is PlatformName {
  return ["slack", "discord", "telegram", "github", "web"].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
