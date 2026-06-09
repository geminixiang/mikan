export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Platform = "slack" | "discord" | "telegram" | string;

export type ConversationLogEventType =
  | "platform.message.received"
  | "platform.attachment.received"
  | "user.command.received"
  | "agent.run.started"
  | "agent.run.event"
  | "agent.response.generated"
  | "platform.delivery.attempted"
  | "platform.delivery.succeeded"
  | "platform.delivery.failed"
  | "message"
  | "agent.response"
  | string;

export interface Attachment {
  original: string;
  localPath: string;
}

export interface LoggedMessage {
  date: string;
  ts: string;
  user: string;
  userName?: string;
  displayName?: string;
  text: string;
  attachments: Attachment[];
  isBot: boolean;
  threadTs?: string;
}

export interface ConversationLogRecord extends LoggedMessage {
  type?: ConversationLogEventType;
  id?: string;
  conversationId?: string;
  occurredAt?: string;
  platform?: Platform;
  actor?: string;
  payload?: JsonValue;
}

export interface ConversationEventRecord {
  id: string;
  conversationId: string;
  type: ConversationLogEventType;
  occurredAt: string;
  platform?: Platform;
  actor?: string;
  payload: JsonValue;
  legacy?: ConversationLogRecord;
}

export interface ConversationTranscriptMessage {
  role: "user" | "assistant";
  text: string;
  user: string;
  userName?: string;
  displayName?: string;
  timestamp: string;
  attachments: Attachment[];
  threadTs?: string;
}

export interface AgentMessageContext {
  conversationId: string;
  logPath: string;
  transcript: ConversationTranscriptMessage[];
  latestTimestamp: string | null;
  events: ConversationEventRecord[];
}

export interface BotResponseLogInput {
  text: string;
  ts: string;
  threadTs?: string;
  date?: string;
  extraFields?: Partial<LoggedMessage>;
}

export interface ConversationLogStoreOptions {
  rootDir: string;
}
