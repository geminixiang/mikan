import type { Office } from "../../../office/types.js";
import type { RunEventHub } from "../../../harness/run-events.js";
import type { MessagingEventHandler, MessagingBot, PlatformName } from "../../../types.js";
import type { TokenRecord } from "../types.js";

export interface SessionViewInteractiveOptions {
  handler: MessagingEventHandler;
  botsByPlatform: Partial<Record<string, MessagingBot>>;
  runEvents: RunEventHub;
}

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
  sessionKey: string;
  title: string;
  updatedAt: string;
  entryCount: number;
  summary?: string;
  anchorEntryId?: string;
}

export interface SessionViewModel {
  sessionId: string;
  sessionKey: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  entryCount: number;
  items: SessionViewItem[];
  parent?: SessionViewRelation;
}

export interface SessionViewToken extends TokenRecord {
  platform: PlatformName;
  platformUserId: string;
  platformUserName?: string;
  conversationId: string;
  sessionKey: string;
  office: Office;
}
