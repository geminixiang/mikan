/**
 * Slack's agent / assistant surface — the app's own pane, separate from
 * channels and ordinary DMs.
 *
 * There are two of these, not one, and they differ in which events signal
 * "someone opened a conversation":
 *
 * | Manifest key      | Opened signal                        | Prompts       |
 * | ----------------- | ------------------------------------ | ------------- |
 * | `agent_view`      | `app_home_opened` with tab=`messages` | pinned to the DM |
 * | `assistant_view`  | `assistant_thread_started`           | per thread    |
 *
 * Slack's own words for the newer one: "rely on the `app_home_opened` event to
 * know when a user has actively opened a DM with your app", and
 * "the `assistant_thread_started` event no longer indicates this". What the
 * docs do *not* say is whether `assistant_thread_started` still fires for an
 * `agent_view` app — so both paths are handled rather than guessed at, which
 * also means an app on either manifest key works without a migration.
 *
 * The two signals need different behaviour, and conflating them would be a
 * bug: `assistant_thread_started` fires once per new conversation, so greeting
 * is right; `app_home_opened` fires **every time the pane is opened**, so
 * greeting there would nag. The agent path therefore only refreshes the
 * pinned prompts, which is idempotent.
 *
 * Session semantics are deliberately unchanged. Each conversation is a thread
 * and mikan already scopes a thread to its own session — the right shape,
 * because the pane's sidebar is a list of separate conversations rather than
 * one transcript. Continuity across them comes from the office's memory.
 *
 * Suggested prompts are deterministic, varying only with the channel Slack
 * says the person is viewing. Enough to feel aware without spending a model
 * call before they have typed anything.
 */
import * as log from "../../log.js";

/** The `assistant_thread` payload on the `assistant_view` lifecycle events. */
export interface AssistantThreadPayload {
  user_id?: string;
  channel_id?: string;
  thread_ts?: string;
  context?: AgentContext;
}

/**
 * Which channel the person is viewing beside the pane. Slack spells this
 * `context` on `app_home_opened` and `app_context_changed`, and `app_context`
 * on `message.im` — the asymmetry is Slack's, normalized here.
 */
export interface AgentContext {
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
  /** `threadTs` omitted pins the prompts to the DM instead of one thread. */
  setSuggestedPrompts(
    channel: string,
    threadTs: string | undefined,
    prompts: SuggestedPrompt[],
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
 * what makes the suggestions feel addressed to the moment.
 */
function promptsFor(channel: string | undefined): SuggestedPrompt[] {
  if (!channel) return DEFAULT_PROMPTS;
  return [
    { title: `#${channel} 在討論什麼`, message: `幫我摘要 #${channel} 最近的討論。` },
    { title: "有什麼要我接手", message: `#${channel} 裡有沒有需要我處理或追蹤的事？` },
    { title: "看看工作區", message: "這個工作區裡有什麼？先給我一個概覽。" },
  ];
}

/**
 * Which conversations belong to this surface, and the context Slack last
 * reported for each.
 *
 * Two levels, because the two manifest keys register at different grains: an
 * `agent_view` DM is known before any thread exists, while an
 * `assistant_view` thread is known individually.
 *
 * In memory on purpose: transient UI state that Slack re-sends on open and on
 * every change, so a restart self-heals on the next interaction. Persisting it
 * would add a store to keep consistent for nothing that survives the trip.
 */
export class AssistantThreadRegistry {
  private threads = new Map<string, AgentContext>();
  private channels = new Map<string, AgentContext>();
  private titled = new Set<string>();

  private key(channelId: string, threadTs: string): string {
    return `${channelId}\n${threadTs}`;
  }

  /** An `assistant_view` thread. */
  remember(channelId: string, threadTs: string, context?: AgentContext): void {
    this.threads.set(this.key(channelId, threadTs), context ?? {});
  }

  /** An `agent_view` DM, which has no thread yet. */
  rememberChannel(channelId: string, context?: AgentContext): void {
    this.channels.set(channelId, context ?? {});
  }

  /** Thread context, falling back to the channel's. */
  contextFor(channelId: string, threadTs: string): AgentContext | undefined {
    return this.threads.get(this.key(channelId, threadTs)) ?? this.channels.get(channelId);
  }

  channelContext(channelId: string): AgentContext | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Whether this thread is part of the pane — either registered individually,
   * or living in a DM known to be the agent surface. The second case is what
   * makes titles work under `agent_view`, where Slack opens threads itself and
   * never announces them.
   */
  isAgentSurface(channelId: string, threadTs: string): boolean {
    return this.threads.has(this.key(channelId, threadTs)) || this.channels.has(channelId);
  }

  /** True the first time a thread is seen, so a title is set exactly once. */
  claimTitle(channelId: string, threadTs: string): boolean {
    const key = this.key(channelId, threadTs);
    if (this.titled.has(key)) return false;
    this.titled.add(key);
    return true;
  }
}

/**
 * `assistant_view`: a new conversation opened. Greet, and offer prompts for
 * that thread.
 *
 * Failures are logged, never thrown. A greeting that did not post is a worse
 * pane, not a broken conversation, and taking the socket handler down over it
 * would break the surface entirely.
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
  const channel = thread.context?.channel_id
    ? ops.channelName(thread.context.channel_id)
    : undefined;

  await swallow("greeting", () =>
    ops.postInThread(channelId, threadTs, channel ? GREETING_WITH_CHANNEL(channel) : GREETING),
  );
  await swallow("setSuggestedPrompts", () =>
    ops.setSuggestedPrompts(channelId, threadTs, promptsFor(channel)),
  );
}

/**
 * `agent_view`: the person opened the app's DM. Refresh the prompts pinned to
 * it — and deliberately do not greet, because Slack sends this on *every*
 * open, so a greeting here would arrive again and again.
 */
export async function handleAgentDmOpened(
  ops: AssistantSurfaceOps,
  registry: AssistantThreadRegistry,
  channelId: string,
  context?: AgentContext,
): Promise<void> {
  if (!channelId) return;
  registry.rememberChannel(channelId, context);
  const channel = context?.channel_id ? ops.channelName(context.channel_id) : undefined;
  // The agent surface is otherwise silent, and its failure mode — no prompts,
  // untitled conversations — looks identical from the outside to Slack simply
  // not sending the event. This line is the difference between the two, and
  // is the first thing to look for when the pane seems inert.
  log.logInfo(
    `[${channelId}] Slack agent DM opened${channel ? ` (viewing #${channel})` : ""}; refreshing suggested prompts`,
  );
  await swallow("setSuggestedPrompts", () =>
    ops.setSuggestedPrompts(channelId, undefined, promptsFor(channel)),
  );
}

/**
 * The person navigated elsewhere. Recorded at both grains so the next turn —
 * and the next prompt refresh — knows where they are, whichever manifest key
 * this app uses.
 */
export function handleAgentContextChanged(
  registry: AssistantThreadRegistry,
  payload: { channel_id?: string; thread_ts?: string; context?: AgentContext },
): void {
  if (!payload.channel_id) return;
  if (payload.thread_ts) {
    registry.remember(payload.channel_id, payload.thread_ts, payload.context);
    return;
  }
  registry.rememberChannel(payload.channel_id, payload.context);
}

/**
 * Title a conversation from the first thing the person said, so the pane's
 * sidebar is navigable. Without it every past conversation looks the same.
 */
export async function titleAssistantThread(
  ops: AssistantSurfaceOps,
  registry: AssistantThreadRegistry,
  channelId: string,
  threadTs: string,
  firstMessage: string,
): Promise<void> {
  if (!registry.isAgentSurface(channelId, threadTs)) return;
  if (!registry.claimTitle(channelId, threadTs)) return;
  const title = summarizeTitle(firstMessage);
  if (!title) return;
  await swallow("setTitle", () => ops.setTitle(channelId, threadTs, title));
}

/**
 * First line, trimmed to something a sidebar can show. Deliberately not a
 * model call: a title is worth having immediately and cheaply, and the
 * person's own words label the conversation better than a paraphrase.
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

async function swallow(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    log.logWarning(
      `Slack agent surface ${label} failed`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
