import type { BotHandler } from "../../adapter.js";
import type { Bot } from "../../adapter.js";
import type { PlatformName } from "../../adapter.js";

// ── command ──────────────────────────────────────────────────────────────────

export interface ParsedSessionViewCommand {
  command: "session" | "/session" | "/pi-session";
}

// ── portal ───────────────────────────────────────────────────────────────────

export interface SessionViewInteractiveOptions {
  handler: BotHandler;
  botsByPlatform: Partial<Record<string, Bot>>;
}

// ── service ──────────────────────────────────────────────────────────────────

export interface SessionViewItem {
  kind: "user" | "assistant" | "tool" | "system";
  title: string;
  body?: string;
  meta?: string;
  tone?: "default" | "ok" | "err" | "muted";
  entryId?: string;
  threads?: SessionViewRelation[];
}

export interface SessionViewRelation {
  kind: "parent" | "thread";
  fileName: string;
  sessionId: string;
  title: string;
  updatedAt: string;
  entryCount: number;
  summary?: string;
  anchorEntryId?: string;
}

export interface SessionViewModel {
  sessionId: string;
  fileName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  entryCount: number;
  items: SessionViewItem[];
  parent?: SessionViewRelation;
  threads: SessionViewRelation[];
}

// ── store ────────────────────────────────────────────────────────────────────

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
