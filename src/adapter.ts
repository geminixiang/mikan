export type ConversationKind = "direct" | "shared";

export type PlatformName = "slack" | "discord" | "telegram";

export interface ChatMessage {
  id: string;
  sessionKey: string;
  conversationKind: ConversationKind;
  userId: string;
  userName?: string;
  text: string;
  attachments?: { name: string; localPath: string }[];
  threadTs?: string;
}

export interface ChatToolResult {
  toolName: string;
  label?: string;
  args?: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface ChatResponseBlockKit {
  text: string;
  blocks: object[];
}

export interface ChatResponseContext {
  respond(text: string): Promise<void>;
  replaceResponse(text: string, options?: { createOverflowLink?: () => string }): Promise<void>;
  respondDiagnostic(text: string, options?: { style?: "muted" | "error" }): Promise<void>;
  respondToolResult(result: ChatToolResult): Promise<void>;
  respondBlockKit?(response: ChatResponseBlockKit): Promise<void>;
  setTyping(isTyping: boolean): Promise<void>;
  setWorking(working: boolean): Promise<void>;
  uploadFile(filePath: string, title?: string): Promise<void>;
  deleteResponse(): Promise<void>;
}

export interface PlatformInfo {
  name: string;
  formattingGuide: string;
  channels: { id: string; name: string }[];
  users: { id: string; userName: string; displayName: string }[];
  diagnostics?: {
    showUsageSummary?: boolean;
  };
}

export interface ChatAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPlatformInfo(): PlatformInfo;
}

/**
 * A platform-agnostic event (message/mention) that triggers the agent.
 */
export interface BotEvent {
  type: string;
  /** Platform-specific raw conversation/channel/chat identifier */
  conversationId: string;
  /** Optional alternate conversation identity used for vault routing. */
  vaultConversationId?: string;
  /** Cross-platform conversation shape: direct message vs shared space */
  conversationKind: ConversationKind;
  /** Message timestamp or ID as string */
  ts: string;
  /** Parent message ID for threaded replies (optional) */
  thread_ts?: string;
  /** User ID */
  user: string;
  /** Message text (already stripped of bot mentions) */
  text: string;
  /** Downloaded attachments */
  attachments?: { name: string; localPath: string }[];
  /** Platform-computed session key; overrides default conversationId:thread_ts computation */
  sessionKey?: string;
}

/**
 * Minimum interface that every platform bot must implement,
 * used by the central handler in main.ts and by EventsWatcher.
 */
export interface Bot {
  start(): Promise<void>;
  postMessage(channel: string, text: string): Promise<string>;
  updateMessage(channel: string, ts: string, text: string): Promise<void>;
  enqueueEvent(event: BotEvent): boolean;
  getPlatformInfo(): PlatformInfo;
  /**
   * Deliver a message visible only to the given user.
   * Implementations may use ephemeral messages (Slack), DMs (Discord), or
   * any other private channel. Absent on platforms with no private delivery.
   */
  postPrivate?(conversationId: string, userId: string, text: string): Promise<void>;
  postPrivateDiagnostic?(
    conversationId: string,
    userId: string,
    text: string,
    options?: { style?: "muted" | "error" },
  ): Promise<void>;
}

/** Pre-created platform adapters passed to the handler */
export interface BotAdapters {
  message: ChatMessage;
  responseCtx: ChatResponseContext;
  platform: PlatformInfo;
}

/**
 * Handler callbacks invoked by each platform bot.
 * Each bot creates platform-specific adapters before calling handleEvent.
 */
export interface RunningSession {
  sessionKey: string;
  startedAt: number; // Date.now() when run started
  /** Last activity timestamp (for detecting hung tasks) */
  lastActivityAt?: number;
  /** Current tool/step being executed (if any) */
  currentTool?: string;
}

export interface BotHandler {
  isRunning(sessionKey: string): boolean;
  getRunningSessions(): RunningSession[];
  handleEvent(event: BotEvent, bot: Bot, adapters: BotAdapters): Promise<void>;
  handleStop(sessionKey: string, conversationId: string, bot: Bot): Promise<void>;
  /** Force stop a running session (bypass normal stop mechanism) */
  forceStop(sessionKey: string): void;
  /** Reset a session: abort if running, delete history, remove from cache */
  handleNewCommand(sessionKey: string, conversationId: string, bot: Bot): Promise<void>;
}
