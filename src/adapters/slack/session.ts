import type { ConversationKind } from "../../adapter.js";
import { resolveChatSessionKey } from "../../session-policy.js";

interface SlackSessionEventLike {
  conversationId: string;
  ts: string;
  thread_ts?: string;
  sessionKey?: string;
}

export type SlackSessionRef =
  | { kind: "channel"; channelId: string }
  | { kind: "fork"; channelId: string; anchorTs: string };

export interface SlackAdapterSessionPlan {
  sessionKey: string;
  rootTs?: string;
  initialMessageTs?: string;
  isThreaded: boolean;
}

export interface SlackEventForkRunPlan<T extends SlackSessionEventLike> {
  event: T;
  initialMessageTs?: string;
}

export function formatSlackSessionKey(ref: SlackSessionRef): string {
  return ref.kind === "channel" ? ref.channelId : `${ref.channelId}:${ref.anchorTs}`;
}

export function parseSlackSessionKey(sessionKey: string): SlackSessionRef {
  const separator = sessionKey.indexOf(":");
  if (separator === -1) {
    return { kind: "channel", channelId: sessionKey };
  }
  return {
    kind: "fork",
    channelId: sessionKey.slice(0, separator),
    anchorTs: sessionKey.slice(separator + 1),
  };
}

export function isSlackForkSessionKey(sessionKey: string): boolean {
  return parseSlackSessionKey(sessionKey).kind === "fork";
}

export function resolveSlackSessionRef(channelId: string, threadTs?: string): SlackSessionRef {
  return threadTs
    ? { kind: "fork", channelId, anchorTs: threadTs }
    : { kind: "channel", channelId };
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

export function resolveSlackRootTs(messageTs: string, threadTs?: string): string {
  return threadTs || messageTs;
}

export function isSlackMessageTs(ts: string | undefined): ts is string {
  return typeof ts === "string" && /^\d+\.\d+$/.test(ts);
}

export function resolveSlackResponseRootTs(
  event: Pick<SlackSessionEventLike, "ts" | "thread_ts">,
): string | undefined {
  return event.thread_ts ?? (isSlackMessageTs(event.ts) ? resolveSlackRootTs(event.ts) : undefined);
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

export function planSlackEventForkRun<T extends SlackSessionEventLike>(
  event: T,
  anchorTs?: string,
): SlackEventForkRunPlan<T> {
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
