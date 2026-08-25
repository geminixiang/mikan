import type { MessagingBot, MessagingEventHandler, OfficeAddress } from "../../adapter.js";
import type { Workspace } from "../../office/index.js";
import type { TokenRecord } from "../types.js";

// ── command ──────────────────────────────────────────────────────────────────

// ── portal ───────────────────────────────────────────────────────────────────

export interface SessionViewInteractiveOptions {
  handler: MessagingEventHandler;
  workspace: Workspace;
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
  address: OfficeAddress;
  platformUserId: string;
  platformUserName?: string;
  /** Initial navigation target; token authority covers all sessions in this canonical office. */
  sessionId: string;
}
