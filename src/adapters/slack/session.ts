import type { ConversationKind } from "../../adapter.js";
import { resolveChatSessionKey } from "../../sessions/policy.js";
import {
  conversationIdOf,
  makeThreadSessionKey,
  threadSuffixOf,
} from "../../sessions/session-key.js";
export type { SlackAdapterSessionPlan, SlackEventAnchorRunPlan, SlackSessionRef } from "./types.js";
import type { SlackAdapterSessionPlan, SlackEventAnchorRunPlan, SlackSessionRef } from "./types.js";

interface SlackSessionEventLike {
  conversationId: string;
  ts: string;
  thread_ts?: string;
  sessionKey?: string;
}

export function formatSlackSessionKey(ref: SlackSessionRef): string {
  return ref.kind === "channel" ? ref.channelId : makeThreadSessionKey(ref.channelId, ref.threadTs);
}

export function parseSlackSessionKey(sessionKey: string): SlackSessionRef {
  const threadTs = threadSuffixOf(sessionKey);
  if (threadTs === null) {
    return { kind: "channel", channelId: sessionKey };
  }
  return { kind: "thread", channelId: conversationIdOf(sessionKey), threadTs };
}

export function isSlackThreadSessionKey(sessionKey: string): boolean {
  return parseSlackSessionKey(sessionKey).kind === "thread";
}

export function resolveSlackSessionKey(channelId: string, threadTs?: string): string {
  const conversationKind: ConversationKind = channelId.startsWith("D") ? "direct" : "shared";
  const sessionKey = resolveChatSessionKey({
    conversationId: channelId,
    conversationKind,
    messageId: channelId,
    threadTs,
    persistentTopLevel: true,
    scopeDirectThreads: true,
  });
  return formatSlackSessionKey(parseSlackSessionKey(sessionKey));
}

function isSlackMessageTs(ts: string | undefined): ts is string {
  return typeof ts === "string" && /^\d+\.\d+$/.test(ts);
}

export function resolveSlackResponseRootTs(
  event: Pick<SlackSessionEventLike, "ts" | "thread_ts">,
): string | undefined {
  return event.thread_ts ?? (isSlackMessageTs(event.ts) ? event.ts : undefined);
}

export function planSlackAdapterSession(
  event: SlackSessionEventLike,
  options: { initialMessageTs?: string } = {},
): SlackAdapterSessionPlan {
  const sessionKey =
    event.sessionKey ?? resolveSlackSessionKey(event.conversationId, event.thread_ts);

  return {
    sessionKey,
    rootTs: options.initialMessageTs ?? resolveSlackResponseRootTs(event),
    initialMessageTs: options.initialMessageTs,
    isThreaded: !!event.thread_ts,
  };
}

export function planSlackEventAnchorRun<T extends SlackSessionEventLike>(
  event: T,
  anchorTs?: string,
): SlackEventAnchorRunPlan<T & { sessionKey?: string }> {
  if (!anchorTs || event.thread_ts) {
    return { event };
  }

  return {
    event: {
      ...event,
      sessionKey: resolveSlackSessionKey(event.conversationId, anchorTs),
    },
    initialMessageTs: anchorTs,
  };
}
