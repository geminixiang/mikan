import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { ConversationKind } from "../adapter.js";
import { buildEventPayload, EventTypeSchema, parseEventPayload } from "../harness/event-format.js";
import * as log from "../log.js";
import { atomicWritePrivateFile } from "../utils/file-guards.js";

const eventSchema = Type.Object({
  action: Type.Optional(
    Type.Union(
      [
        Type.Literal("create"),
        Type.Literal("list"),
        Type.Literal("read"),
        Type.Literal("update"),
        Type.Literal("delete"),
      ],
      { description: "CRUD action. Defaults to create for backward compatibility." },
    ),
  ),
  filename: Type.Optional(
    Type.String({
      description: "Event filename for read, update, or delete actions",
    }),
  ),
  scope: Type.Optional(
    Type.Union([Type.Literal("conversation"), Type.Literal("all")], {
      description:
        "List scope. Defaults to conversation, which only shows events for the current conversation. Use all only when the user explicitly asks for all events.",
    }),
  ),
  label: Type.Optional(
    Type.String({
      description: "Brief description of the event you're scheduling (shown to user)",
    }),
  ),
  type: Type.Optional(EventTypeSchema),
  text: Type.Optional(
    Type.String({
      description:
        "A self-contained task for the future run. Include the necessary context, tone, and constraints in the text itself because events do not inherit normal conversation history.",
    }),
  ),
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
  conversationKind: ConversationKind;
  userId: string;
}

type EventToolParams = {
  action?: "create" | "list" | "read" | "update" | "delete";
  filename?: string;
  scope?: "conversation" | "all";
  label?: string;
  type?: "immediate" | "one-shot" | "periodic";
  text?: string;
  at?: string;
  schedule?: string;
  timezone?: string;
  filenamePrefix?: string;
};

export type { EventPayload, EventStore } from "./types.js";
import type { EventPayload, EventStore } from "./types.js";

export class HostEventStore implements EventStore {
  constructor(private readonly eventsDir: string) {}

  static fromWorkspaceDir(workspaceDir: string): HostEventStore {
    return new HostEventStore(join(workspaceDir, "events"));
  }

  async write(filename: string, payload: EventPayload): Promise<{ path: string; size: number }> {
    return this.writePayload(filename, payload);
  }

  async list(): Promise<
    Array<{ filename: string; payload: EventPayload | null; size: number; mtimeMs: number }>
  > {
    await mkdir(this.eventsDir, { recursive: true });
    const entries = await readdir(this.eventsDir, { withFileTypes: true });
    const events = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            return await this.read(entry.name);
          } catch {
            // Keep unparseable files visible (payload: null) so consumers can
            // surface and delete them; skip files that vanished mid-listing.
            try {
              const fileStat = await stat(join(this.eventsDir, entry.name));
              return {
                filename: entry.name,
                payload: null,
                size: fileStat.size,
                mtimeMs: fileStat.mtimeMs,
              };
            } catch {
              return null;
            }
          }
        }),
    );
    return events
      .filter((event) => event !== null)
      .toSorted((a, b) => a.filename.localeCompare(b.filename));
  }

  async read(
    filename: string,
  ): Promise<{ filename: string; payload: EventPayload; size: number; mtimeMs: number }> {
    const safeFilename = validateEventFilename(filename);
    const filePath = join(this.eventsDir, safeFilename);
    const [raw, fileStat] = await Promise.all([readFile(filePath, "utf-8"), stat(filePath)]);
    // Validation (shape, per-type fields, channelId alias) is owned by the
    // event-format module; files that fail it surface as payload:null in
    // list() and as errors here.
    const payload = parseEventPayload(raw, safeFilename);
    return {
      filename: safeFilename,
      payload,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  }

  async update(filename: string, payload: EventPayload): Promise<{ path: string; size: number }> {
    return this.writePayload(filename, payload, true);
  }

  async delete(filename: string): Promise<{ deleted: boolean }> {
    const safeFilename = validateEventFilename(filename);
    await rm(join(this.eventsDir, safeFilename), { force: true });
    return { deleted: true };
  }

  private async writePayload(
    filename: string,
    payload: EventPayload,
    requireExisting = false,
  ): Promise<{ path: string; size: number }> {
    await mkdir(this.eventsDir, { recursive: true });
    const safeFilename = validateEventFilename(filename);
    const filePath = join(this.eventsDir, safeFilename);
    if (requireExisting) {
      await stat(filePath);
    }
    atomicWritePrivateFile(filePath, JSON.stringify(payload) + "\n");
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
      "CRUD tool for scheduled events. Create immediate, one-shot, or periodic events for the current conversation. List defaults to events for the current conversation only; use scope=all only when the user explicitly asks to list all events. Event text must be self-contained because events do not inherit normal conversation history.",
    parameters: eventSchema,
    execute: async (_toolCallId: string, params: EventToolParams, signal?: AbortSignal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      if (!eventContext) {
        throw new Error("Event context not configured");
      }

      const action = params.action ?? "create";

      if (action === "list") {
        const events = await eventStore.list();
        const { conversationId, platform } = eventContext;
        const scopedEvents =
          params.scope === "all"
            ? events
            : events.filter(
                (event) =>
                  event.payload?.conversationId === conversationId &&
                  // Same raw id on another platform is another office. Files
                  // written before payloads carried a platform stay visible.
                  (event.payload.platform === undefined || event.payload.platform === platform),
              );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  scope: params.scope ?? "conversation",
                  conversationId: params.scope === "all" ? undefined : conversationId,
                  events: scopedEvents,
                },
                null,
                2,
              ),
            },
          ],
          details: undefined,
        };
      }

      if (action === "read") {
        const filename = requireFilename(params);
        const event = await eventStore.read(filename);
        return {
          content: [{ type: "text", text: JSON.stringify(event, null, 2) }],
          details: undefined,
        };
      }

      if (action === "delete") {
        const filename = requireFilename(params);
        await eventStore.delete(filename);
        return {
          content: [{ type: "text", text: `Deleted event ${filename}` }],
          details: undefined,
        };
      }

      const payload = buildToolEventPayload(params, eventContext);
      const filename =
        action === "update"
          ? requireFilename(params)
          : `${sanitizeFileSegment(params.filenamePrefix || payload.type || "event")}-${Date.now()}.json`;

      log.logInfo(
        `${action === "update" ? "Updating" : "Writing"} event file via control plane store: ${filename} (type=${payload.type}, platform=${payload.platform}, conversation=${payload.conversationId})`,
      );

      try {
        const result =
          action === "update"
            ? await eventStore.update(filename, payload)
            : await eventStore.write(filename, payload);
        log.logInfo(
          `${action === "update" ? "Updated" : "Wrote"} event file via control plane store: ${result.path} (${result.size} bytes)`,
        );
      } catch (err) {
        log.logWarning(
          `Failed to ${action === "update" ? "update" : "write"} event file via control plane store: ${filename}`,
          String(err),
        );
        throw err;
      }

      return {
        content: [{ type: "text", text: formatEventWriteResult(action, filename, payload) }],
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

function buildToolEventPayload(params: EventToolParams, context: EventToolContext): EventPayload {
  if (!params.type) {
    throw new Error("`type` is required for create and update actions");
  }
  if (!params.text) {
    throw new Error("`text` is required for create and update actions");
  }

  // Per-type field rules live in the event-format module. No sessionKey or
  // threadTs in the payload: reminders should fire as top-level messages,
  // not buried in old threads.
  const payload = buildEventPayload({
    type: params.type,
    platform: context.platform,
    conversationId: context.conversationId,
    conversationKind: context.conversationKind,
    userId: context.userId,
    text: params.text,
    at: params.at,
    schedule: params.schedule,
    timezone: params.timezone,
  });

  // Tool-side write policy, not format knowledge: a reminder in the past
  // would be deleted unfired by the watcher, so reject it here.
  if (payload.type === "one-shot" && new Date(payload.at).getTime() <= Date.now()) {
    throw new Error(
      `\`at\` must be in the future; got ${payload.at} (now=${new Date().toISOString()}). Check the timezone offset.`,
    );
  }

  return payload;
}

function formatEventWriteResult(
  action: "create" | "update",
  filename: string,
  payload: EventPayload,
): string {
  const scheduledVerb = action === "update" ? "Updated" : "Scheduled";
  const immediateVerb = action === "update" ? "Updated" : "Queued";
  const target = payload.platform
    ? `${payload.platform}/${payload.conversationId}`
    : payload.conversationId;
  switch (payload.type) {
    case "periodic":
      return `${scheduledVerb} periodic event ${filename} for ${target} (${payload.schedule} ${payload.timezone})`;
    case "one-shot":
      return `${scheduledVerb} one-shot event ${filename} for ${target} at ${payload.at}`;
    case "immediate":
      return `${immediateVerb} immediate event ${filename} for ${target}`;
  }
}

function requireFilename(params: EventToolParams): string {
  if (!params.filename) {
    throw new Error("`filename` is required for read, update, and delete actions");
  }
  return validateEventFilename(params.filename);
}

function validateEventFilename(filename: string): string {
  const trimmed = filename.trim();
  if (
    !trimmed ||
    trimmed !== basename(trimmed) ||
    trimmed.includes("..") ||
    !trimmed.endsWith(".json")
  ) {
    throw new Error("Invalid event filename");
  }
  return trimmed;
}

function sanitizeFileSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "event";
}
