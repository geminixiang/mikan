import type { MessagingEventHandler } from "../../adapter.js";
import type { MessagingBot } from "../../adapter.js";
import type { PlatformName } from "../../adapter.js";
import type { TokenRecord } from "../types.js";

// ── command ──────────────────────────────────────────────────────────────────

export interface ParsedSessionViewCommand {
  command: "session" | "/session" | "/pi-session";
}

// ── portal ───────────────────────────────────────────────────────────────────

export interface SessionViewInteractiveOptions {
  handler: MessagingEventHandler;
  botsByPlatform: Partial<Record<string, MessagingBot>>;
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

export interface SessionViewToken extends TokenRecord {
  platform: PlatformName;
  platformUserId: string;
  platformUserName?: string;
  conversationId: string;
  sessionKey: string;
  sessionFile: string;
}
