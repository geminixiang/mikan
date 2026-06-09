import { randomUUID } from "crypto";
import { appendFileSync, mkdirSync, readFileSync } from "fs";
import { appendFile } from "fs/promises";
import { join } from "path";
import type {
  AgentMessageContext,
  BotResponseLogInput,
  ConversationEventRecord,
  ConversationLogEventType,
  ConversationLogRecord,
  ConversationLogStoreOptions,
  ConversationTranscriptMessage,
  JsonValue,
  LoggedMessage,
} from "./types.js";

export class ConversationLogStore {
  constructor(private readonly options: ConversationLogStoreOptions) {}

  getConversationDir(conversationId: string): string {
    const dir = join(this.options.rootDir, conversationId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  getLogPath(conversationId: string): string {
    return join(this.getConversationDir(conversationId), "log.jsonl");
  }

  async append(conversationId: string, record: ConversationLogRecord): Promise<void> {
    await appendFile(this.getLogPath(conversationId), `${JSON.stringify(record)}\n`, "utf-8");
  }

  appendSync(conversationId: string, record: ConversationLogRecord): void {
    appendFileSync(this.getLogPath(conversationId), `${JSON.stringify(record)}\n`, "utf-8");
  }

  async appendLoggedMessage(conversationId: string, message: LoggedMessage): Promise<void> {
    await this.append(conversationId, normalizeLoggedMessage(message));
  }

  appendLoggedMessageSync(conversationId: string, message: LoggedMessage): void {
    this.appendSync(conversationId, normalizeLoggedMessage(message));
  }

  async appendBotResponse(
    conversationId: string,
    input: BotResponseLogInput,
  ): Promise<void> {
    await this.appendLoggedMessage(conversationId, createBotResponseLogMessage(input));
  }

  appendBotResponseSync(conversationId: string, input: BotResponseLogInput): void {
    this.appendLoggedMessageSync(conversationId, createBotResponseLogMessage(input));
  }

  async appendEvent(conversationId: string, event: ConversationEventRecord): Promise<void> {
    await this.append(conversationId, eventToLogRecord(event));
  }

  read(conversationId: string): ConversationLogRecord[] {
    const logPath = join(this.options.rootDir, conversationId, "log.jsonl");
    let content: string;
    try {
      content = readFileSync(logPath, "utf-8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const records: ConversationLogRecord[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      records.push(parseConversationLogRecord(trimmed));
    }
    return records;
  }

  readEvents(conversationId: string): ConversationEventRecord[] {
    return this.read(conversationId).map((record) => toEventRecord(conversationId, record));
  }

  getLastTimestamp(conversationId: string): string | null {
    const records = this.read(conversationId);
    return records.at(-1)?.ts ?? null;
  }

  buildTranscript(conversationId: string): ConversationTranscriptMessage[] {
    return this.read(conversationId).map(toTranscriptMessage);
  }

  buildAgentMessageContext(conversationId: string): AgentMessageContext {
    return {
      conversationId,
      logPath: join(this.options.rootDir, conversationId, "log.jsonl"),
      transcript: this.buildTranscript(conversationId),
      latestTimestamp: this.getLastTimestamp(conversationId),
      events: this.readEvents(conversationId),
    };
  }
}

export function createConversationLogStore(
  options: ConversationLogStoreOptions,
): ConversationLogStore {
  return new ConversationLogStore(options);
}

export function normalizeLoggedMessage(message: LoggedMessage): ConversationLogRecord {
  return {
    ...message,
    type: message.isBot ? "agent.response.generated" : "platform.message.received",
    occurredAt: message.date,
    payload: messageToPayload(message),
  };
}

export function normalizeLogEntry(entry: object): ConversationLogRecord {
  return normalizeLoggedMessage(entry as LoggedMessage);
}

export function appendLoggedMessageSync(
  options: ConversationLogStoreOptions,
  conversationId: string,
  message: LoggedMessage,
): void {
  createConversationLogStore(options).appendLoggedMessageSync(conversationId, message);
}

export function appendBotResponseLogSync(
  options: ConversationLogStoreOptions,
  conversationId: string,
  input: BotResponseLogInput,
): void {
  createConversationLogStore(options).appendBotResponseSync(conversationId, input);
}

export function createBotResponseLogMessage(input: BotResponseLogInput): LoggedMessage {
  return {
    date: input.date ?? new Date().toISOString(),
    ts: input.ts,
    threadTs: input.threadTs,
    user: "bot",
    text: input.text,
    attachments: [],
    isBot: true,
    ...input.extraFields,
  };
}

export function createConversationEvent(input: {
  conversationId: string;
  type: ConversationLogEventType;
  occurredAt?: string;
  platform?: string;
  actor?: string;
  payload?: JsonValue;
  legacy?: ConversationLogRecord;
}): ConversationEventRecord {
  return {
    id: randomUUID(),
    conversationId: input.conversationId,
    type: input.type,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    platform: input.platform,
    actor: input.actor,
    payload: input.payload ?? {},
    legacy: input.legacy,
  };
}

function eventToLogRecord(event: ConversationEventRecord): ConversationLogRecord {
  if (event.legacy) {
    return {
      ...event.legacy,
      id: event.id,
      conversationId: event.conversationId,
      type: event.type,
      occurredAt: event.occurredAt,
      platform: event.platform,
      actor: event.actor,
      payload: event.payload,
    };
  }

  const text = typeof event.payload === "object" && event.payload && "text" in event.payload
    ? String(event.payload.text)
    : "";
  return {
    id: event.id,
    conversationId: event.conversationId,
    type: event.type,
    occurredAt: event.occurredAt,
    date: event.occurredAt,
    ts: event.occurredAt,
    user: event.actor ?? "system",
    text,
    attachments: [],
    isBot: event.type.startsWith("agent."),
    platform: event.platform,
    actor: event.actor,
    payload: event.payload,
  };
}

function parseConversationLogRecord(line: string): ConversationLogRecord {
  const value: unknown = JSON.parse(line);
  if (!isConversationLogRecord(value)) {
    throw new Error("invalid conversation log record");
  }
  return value;
}

function isConversationLogRecord(value: unknown): value is ConversationLogRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ConversationLogRecord>;
  return (
    typeof record.date === "string" &&
    typeof record.ts === "string" &&
    typeof record.user === "string" &&
    typeof record.text === "string" &&
    Array.isArray(record.attachments) &&
    typeof record.isBot === "boolean"
  );
}

function toEventRecord(conversationId: string, record: ConversationLogRecord): ConversationEventRecord {
  return {
    id: record.id ?? `${conversationId}:${record.ts}:${record.user}`,
    conversationId: record.conversationId ?? conversationId,
    type: record.type ?? (record.isBot ? "agent.response.generated" : "platform.message.received"),
    occurredAt: record.occurredAt ?? record.date,
    platform: record.platform,
    actor: record.actor ?? record.user,
    payload: record.payload ?? messageToPayload(record),
    legacy: record,
  };
}

function toTranscriptMessage(record: ConversationLogRecord): ConversationTranscriptMessage {
  return {
    role: record.isBot ? "assistant" : "user",
    text: record.text,
    user: record.user,
    userName: record.userName,
    displayName: record.displayName,
    timestamp: record.date,
    attachments: record.attachments,
    threadTs: record.threadTs,
  };
}

function messageToPayload(message: LoggedMessage): JsonValue {
  return {
    text: message.text,
    ts: message.ts,
    threadTs: message.threadTs ?? null,
    attachments: message.attachments.map((attachment) => ({
      original: attachment.original,
      localPath: attachment.localPath,
    })),
    isBot: message.isBot,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
