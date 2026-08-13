import type { MessagingEventHandler } from "../../adapter.js";
import type { MessagingBot } from "../../adapter.js";
import type { PlatformName } from "../../adapter.js";
import type { TokenRecord } from "../types.js";
import type {
  SessionViewItem,
  SessionViewRelation,
  SessionViewModel,
} from "@geminixiang/mikan-daemon-web-bridge";

export type { SessionViewItem, SessionViewRelation, SessionViewModel };

// ── command ──────────────────────────────────────────────────────────────────

// ── portal ───────────────────────────────────────────────────────────────────

export interface SessionViewInteractiveOptions {
  handler: MessagingEventHandler;
  botsByPlatform: Partial<Record<string, MessagingBot>>;
}

// ── service ──────────────────────────────────────────────────────────────────

// SessionViewItem / SessionViewRelation / SessionViewModel live in
// @geminixiang/mikan-daemon-web-bridge (single home for the daemon↔web wire
// contract); re-exported here so existing import sites keep working.

// ── store ────────────────────────────────────────────────────────────────────

export interface SessionViewToken extends TokenRecord {
  platform: PlatformName;
  platformUserId: string;
  platformUserName?: string;
  conversationId: string;
  sessionKey: string;
  sessionFile: string;
}
