/**
 * The Slack assistant surface (an "AI app" in the Agents & AI apps sidebar).
 *
 * Slack drives this container through a lifecycle the classic app path does
 * not have: when someone opens a new conversation it sends
 * `assistant_thread_started` and waits for the app to say something, and it
 * sends `assistant_thread_context_changed` as the person navigates so the app
 * knows which channel they are looking at. An app that ignores both still
 * *works* — messages arrive as ordinary DM thread messages — but the pane
 * opens empty, the suggestions never appear, and the sidebar fills with
 * untitled entries, which reads as a broken integration rather than a quiet
 * one.
 *
 * Session semantics are deliberately unchanged. Each assistant conversation is
 * a thread, and mikan already scopes a thread to its own session — which is
 * the right shape here, because the sidebar is a list of separate
 * conversations, not one long transcript. Continuity across them comes from
 * the office's memory, not from sharing a session.
 *
 * Suggested prompts are deterministic. They vary with the channel context
 * Slack hands us, which is enough to feel aware without spending a model call
 * (and a second or two of latency) before the user has typed anything.
 */
import * as log from "../../log.js";

/** The `assistant_thread` payload Slack sends with both lifecycle events. */
export interface AssistantThreadPayload {
  user_id?: string;
  channel_id?: string;
  thread_ts?: string;
  context?: AssistantThreadContext;
}

export interface AssistantThreadContext {
  /** The channel the user is viewing while the assistant pane is open. */
  channel_id?: string;
  team_id?: string;
  enterprise_id?: string | null;
}

export interface SuggestedPrompt {
  title: string;
  message: string;
}

/** What the adapter needs from the bot to serve this surface. */
export interface AssistantSurfaceOps {
  postInThread(channel: string, threadTs: string, text: string): Promise<string>;
  setSuggestedPrompts(
    channel: string,
    threadTs: string,
    prompts: SuggestedPrompt[],
    title?: string,
  ): Promise<void>;
  setTitle(channel: string, threadTs: string, title: string): Promise<void>;
  /** Human-readable channel name for context, when the bot knows it. */
  channelName(channelId: string): string | undefined;
}

const GREETING = "有什麼我可以幫忙的？";
const GREETING_WITH_CHANNEL = (channel: string) =>
  `有什麼我可以幫忙的？我看得到你正在 #${channel}。`;

/** Prompts offered with no channel context — general-purpose starting points. */
const DEFAULT_PROMPTS: SuggestedPrompt[] = [
  { title: "看看工作區", message: "這個工作區裡有什麼？先給我一個概覽。" },
  { title: "最近的變更", message: "最近的程式碼變更有哪些？挑重要的說。" },
  { title: "排一個提醒", message: "幫我排一個每天早上的提醒。" },
];

/**
 * Prompts when Slack tells us which channel the person is looking at. Naming
 * the channel is the cheap half of "context-aware": it costs nothing and it is
 * the thing that makes the suggestions feel addressed to the moment.
 */
function channelPrompts(channel: string): SuggestedPrompt[] {
  return [
    { title: `#${channel} 在討論什麼`, message: `幫我摘要 #${channel} 最近的討論。` },
    { title: "有什麼要我接手", message: `#${channel} 裡有沒有需要我處理或追蹤的事？` },
    { title: "看看工作區", message: "這個工作區裡有什麼？先給我一個概覽。" },
  ];
}

/**
 * Tracks which threads belong to the assistant surface and what context Slack
 * last reported for each.
 *
 * In memory on purpose: this is transient UI state, and Slack re-sends the
 * context when a thread starts and whenever it changes, so a restart
 * self-heals on the next interaction. Persisting it would add a store to keep
 * consistent for no behaviour that survives the round trip.
 */
export class AssistantThreadRegistry {
  private contexts = new Map<string, AssistantThreadContext>();
  private titled = new Set<string>();

  private key(channelId: string, threadTs: string): string {
    return `${channelId}\n${threadTs}`;
  }

  remember(channelId: string, threadTs: string, context?: AssistantThreadContext): void {
    this.contexts.set(this.key(channelId, threadTs), context ?? {});
  }

  contextFor(channelId: string, threadTs: string): AssistantThreadContext | undefined {
    return this.contexts.get(this.key(channelId, threadTs));
  }

  isAssistantThread(channelId: string, threadTs: string): boolean {
    return this.contexts.has(this.key(channelId, threadTs));
  }

  /** True the first time a thread is seen, so a title is set exactly once. */
  claimTitle(channelId: string, threadTs: string): boolean {
    const key = this.key(channelId, threadTs);
    if (this.titled.has(key)) return false;
    this.titled.add(key);
    return true;
  }

  forget(channelId: string, threadTs: string): void {
    const key = this.key(channelId, threadTs);
    this.contexts.delete(key);
    this.titled.delete(key);
  }
}

/**
 * Open a new assistant conversation: greet, and offer prompts shaped by
 * whatever context Slack supplied.
 *
 * Failures are logged, never thrown. A greeting that did not post is a worse
 * pane, not a broken conversation — the user can still type, and taking the
 * socket handler down over it would break the surface entirely.
 */
export async function handleAssistantThreadStarted(
  ops: AssistantSurfaceOps,
  registry: AssistantThreadRegistry,
  thread: AssistantThreadPayload,
): Promise<void> {
  const channelId = thread.channel_id;
  const threadTs = thread.thread_ts;
  if (!channelId || !threadTs) return;

  registry.remember(channelId, threadTs, thread.context);

  const contextChannelId = thread.context?.channel_id;
  const contextChannel = contextChannelId ? ops.channelName(contextChannelId) : undefined;

  try {
    await ops.postInThread(
      channelId,
      threadTs,
      contextChannel ? GREETING_WITH_CHANNEL(contextChannel) : GREETING,
    );
  } catch (err) {
    log.logWarning(
      "Slack assistant greeting failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    await ops.setSuggestedPrompts(
      channelId,
      threadTs,
      contextChannel ? channelPrompts(contextChannel) : DEFAULT_PROMPTS,
    );
  } catch (err) {
    log.logWarning(
      "Slack assistant setSuggestedPrompts failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** The person navigated elsewhere; remember where, for the next turn. */
export function handleAssistantThreadContextChanged(
  registry: AssistantThreadRegistry,
  thread: AssistantThreadPayload,
): void {
  if (!thread.channel_id || !thread.thread_ts) return;
  registry.remember(thread.channel_id, thread.thread_ts, thread.context);
}

/**
 * Title an assistant thread from the first thing the person said, so the
 * sidebar is navigable. Slack shows these as the conversation list, and
 * without them every past conversation looks the same.
 */
export async function titleAssistantThread(
  ops: AssistantSurfaceOps,
  registry: AssistantThreadRegistry,
  channelId: string,
  threadTs: string,
  firstMessage: string,
): Promise<void> {
  if (!registry.isAssistantThread(channelId, threadTs)) return;
  if (!registry.claimTitle(channelId, threadTs)) return;
  const title = summarizeTitle(firstMessage);
  if (!title) return;
  try {
    await ops.setTitle(channelId, threadTs, title);
  } catch (err) {
    log.logWarning(
      "Slack assistant setTitle failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * First line, trimmed to something a sidebar can show. Deliberately not a
 * model call: a title is worth having immediately and cheaply, and the user's
 * own words are a better label than a paraphrase.
 */
export function summarizeTitle(message: string): string {
  const firstLine = message
    .replace(/<@[^>]+>/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return "";
  return firstLine.length <= 50 ? firstLine : `${firstLine.slice(0, 49)}…`;
}
