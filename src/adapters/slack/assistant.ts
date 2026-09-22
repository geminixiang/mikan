import * as log from "../../log.js";
import type {
  AgentContext,
  AssistantSurfaceOps,
  AssistantThreadPayload,
  SuggestedPrompt,
} from "./types.js";

export type {
  AgentContext,
  AssistantSurfaceOps,
  AssistantThreadPayload,
  SuggestedPrompt,
} from "./types.js";

const GREETING = "有什麼我可以幫忙的？";
const GREETING_WITH_CHANNEL = (channel: string) =>
  `有什麼我可以幫忙的？我看得到你正在 #${channel}。`;

const DEFAULT_PROMPTS: SuggestedPrompt[] = [
  { title: "看看工作區", message: "這個工作區裡有什麼？先給我一個概覽。" },
  { title: "最近的變更", message: "最近的程式碼變更有哪些？挑重要的說。" },
  { title: "排一個提醒", message: "幫我排一個每天早上的提醒。" },
];

function promptsFor(channel: string | undefined): SuggestedPrompt[] {
  if (!channel) return DEFAULT_PROMPTS;
  return [
    { title: `#${channel} 在討論什麼`, message: `幫我摘要 #${channel} 最近的討論。` },
    { title: "有什麼要我接手", message: `#${channel} 裡有沒有需要我處理或追蹤的事？` },
    { title: "看看工作區", message: "這個工作區裡有什麼？先給我一個概覽。" },
  ];
}

export class AssistantThreadRegistry {
  private threads = new Map<string, AgentContext>();
  private channels = new Map<string, AgentContext>();
  private titled = new Set<string>();

  private key(channelId: string, threadTs: string): string {
    return `${channelId}\n${threadTs}`;
  }

  remember(channelId: string, threadTs: string, context?: AgentContext): void {
    this.threads.set(this.key(channelId, threadTs), context ?? {});
  }

  rememberChannel(channelId: string, context?: AgentContext): void {
    this.channels.set(channelId, context ?? {});
  }

  contextFor(channelId: string, threadTs: string): AgentContext | undefined {
    return this.threads.get(this.key(channelId, threadTs)) ?? this.channels.get(channelId);
  }

  channelContext(channelId: string): AgentContext | undefined {
    return this.channels.get(channelId);
  }

  isAgentSurface(channelId: string, threadTs: string): boolean {
    return this.threads.has(this.key(channelId, threadTs)) || this.channels.has(channelId);
  }

  claimTitle(channelId: string, threadTs: string): boolean {
    const key = this.key(channelId, threadTs);
    if (this.titled.has(key)) return false;
    this.titled.add(key);
    return true;
  }
}

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

export async function handleAgentDmOpened(
  ops: AssistantSurfaceOps,
  registry: AssistantThreadRegistry,
  channelId: string,
  context?: AgentContext,
): Promise<void> {
  if (!channelId) return;
  registry.rememberChannel(channelId, context);
  const channel = context?.channel_id ? ops.channelName(context.channel_id) : undefined;
  log.logInfo(
    `[${channelId}] Slack agent DM opened${channel ? ` (viewing #${channel})` : ""}; refreshing suggested prompts`,
  );
  await swallow("setSuggestedPrompts", () =>
    ops.setSuggestedPrompts(channelId, undefined, promptsFor(channel)),
  );
}

export function handleAgentContextChanged(
  registry: AssistantThreadRegistry,
  payload: { channel_id?: string; thread_ts?: string; context?: AgentContext },
): void {
  if (!payload.channel_id) return;
  log.logInfo(
    `[${payload.channel_id}] Slack agent context changed${payload.context?.channel_id ? ` (viewing ${payload.context.channel_id})` : ""}`,
  );
  if (payload.thread_ts) {
    registry.remember(payload.channel_id, payload.thread_ts, payload.context);
    return;
  }
  registry.rememberChannel(payload.channel_id, payload.context);
}

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
