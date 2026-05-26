import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as log from "../log.js";

const eventSchema = Type.Object({
  label: Type.String({
    description: "Brief description of the event you're scheduling (shown to user)",
  }),
  type: Type.Union([Type.Literal("immediate"), Type.Literal("one-shot"), Type.Literal("periodic")]),
  text: Type.String({
    description:
      "A self-contained task for the future run. Include the necessary context, tone, and constraints in the text itself because events do not inherit normal conversation history.",
  }),
  at: Type.Optional(
    Type.String({
      description: "ISO 8601 timestamp with offset, required for one-shot events",
    }),
  ),
  schedule: Type.Optional(
    Type.String({
      description: "Cron schedule, required for periodic events",
    }),
  ),
  timezone: Type.Optional(
    Type.String({
      description: "IANA timezone, required for periodic events",
    }),
  ),
  filenamePrefix: Type.Optional(
    Type.String({
      description: "Optional filename prefix for the event file",
    }),
  ),
});

interface EventToolContext {
  platform: string;
  conversationId: string;
  conversationKind: "direct" | "shared";
  userId: string;
}

type EventToolParams = {
  label: string;
  type: "immediate" | "one-shot" | "periodic";
  text: string;
  at?: string;
  schedule?: string;
  timezone?: string;
  filenamePrefix?: string;
};

export type EventPayload =
  | {
      type: "immediate";
      platform: string;
      conversationId: string;
      conversationKind: "direct" | "shared";
      userId: string;
      text: string;
    }
  | {
      type: "one-shot";
      platform: string;
      conversationId: string;
      conversationKind: "direct" | "shared";
      userId: string;
      text: string;
      at: string;
    }
  | {
      type: "periodic";
      platform: string;
      conversationId: string;
      conversationKind: "direct" | "shared";
      userId: string;
      text: string;
      schedule: string;
      timezone: string;
    };

export interface EventStore {
  write(filename: string, payload: EventPayload): Promise<{ path: string; size: number }>;
}

export class HostEventStore implements EventStore {
  constructor(private readonly eventsDir: string) {}

  static fromWorkspaceDir(workspaceDir: string): HostEventStore {
    return new HostEventStore(join(workspaceDir, "events"));
  }

  async write(filename: string, payload: EventPayload): Promise<{ path: string; size: number }> {
    await mkdir(this.eventsDir, { recursive: true });
    const filePath = join(this.eventsDir, filename);
    await writeFile(filePath, JSON.stringify(payload) + "\n", "utf-8");
    const fileStat = await stat(filePath);
    return { path: filePath, size: fileStat.size };
  }
}

export function createEventTool(eventStore: EventStore): {
  tool: AgentTool<typeof eventSchema>;
  setEventContext: (context: EventToolContext) => void;
} {
  let eventContext: EventToolContext | null = null;

  const tool: AgentTool<typeof eventSchema> = {
    name: "event",
    label: "event",
    description:
      "Schedule an immediate, one-shot, or periodic event for the current conversation. Write text as a self-contained task with any needed context, tone, or constraints because events do not inherit normal conversation history. This automatically writes to the correct events directory and fills the current platform, conversation, conversation kind, and requester userId.",
    parameters: eventSchema,
    execute: async (_toolCallId: string, params: EventToolParams, signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (!eventContext) {
        throw new Error("Event context not configured");
      }

      const payload = buildEventPayload(params, eventContext);
      const prefix = sanitizeFileSegment(params.filenamePrefix || payload.type || "event");
      const filename = `${prefix}-${Date.now()}.json`;

      log.logInfo(
        `Writing event file via control plane store: ${filename} (type=${payload.type}, platform=${payload.platform}, conversation=${payload.conversationId})`,
      );

      try {
        const result = await eventStore.write(filename, payload);
        log.logInfo(
          `Wrote event file via control plane store: ${result.path} (${result.size} bytes)`,
        );
      } catch (err) {
        log.logWarning(
          `Failed to write event file via control plane store: ${filename}`,
          String(err),
        );
        throw err;
      }

      return {
        content: [
          {
            type: "text",
            text:
              payload.type === "periodic"
                ? `Scheduled periodic event ${filename} for ${payload.platform}/${payload.conversationId} (${payload.schedule} ${payload.timezone})`
                : payload.type === "one-shot"
                  ? `Scheduled one-shot event ${filename} for ${payload.platform}/${payload.conversationId} at ${payload.at}`
                  : `Queued immediate event ${filename} for ${payload.platform}/${payload.conversationId}`,
          },
        ],
        details: undefined,
      };
    },
  };

  return {
    tool,
    setEventContext: (context: EventToolContext) => {
      eventContext = context;
    },
  };
}

function buildEventPayload(params: EventToolParams, context: EventToolContext): EventPayload {
  const base = {
    platform: context.platform,
    conversationId: context.conversationId,
    conversationKind: context.conversationKind,
    userId: context.userId,
    text: params.text,
  };

  if (params.type === "immediate") {
    return {
      ...base,
      type: "immediate",
    };
  }

  if (params.type === "one-shot") {
    if (!params.at) {
      throw new Error("`at` is required for one-shot events");
    }

    const atTime = new Date(params.at).getTime();
    if (Number.isNaN(atTime)) {
      throw new Error("`at` must be a valid ISO 8601 timestamp with UTC offset");
    }
    if (atTime <= Date.now()) {
      throw new Error(
        `\`at\` must be in the future; got ${params.at} (now=${new Date().toISOString()}). Check the timezone offset.`,
      );
    }

    // No sessionKey or threadTs: reminders should fire as top-level messages, not buried in old threads
    return { ...base, type: "one-shot", at: params.at };
  }

  if (!params.schedule) {
    throw new Error("`schedule` is required for periodic events");
  }
  if (!params.timezone) {
    throw new Error("`timezone` is required for periodic events");
  }
  return {
    ...base,
    type: "periodic",
    schedule: params.schedule,
    timezone: params.timezone,
  };
}

function sanitizeFileSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "event";
}
