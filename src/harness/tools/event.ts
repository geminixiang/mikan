import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import type { ConversationKind } from "../../adapter.js";
import { buildEventPayload, EventTypeSchema, validateEventFilename } from "../../events/index.js";
import type { EventPayload, EventStore } from "../../events/index.js";
import * as log from "../../log.js";

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

/** Derived from the advertised schema, so the two can never drift apart. */
type EventToolParams = Static<typeof eventSchema>;

/** Every event action answers with one text block and no structured details. */
type EventToolResult = Awaited<ReturnType<AgentTool<typeof eventSchema>["execute"]>>;

function textResult(text: string): EventToolResult {
  return { content: [{ type: "text", text }], details: undefined };
}

/** Log verbs per write action, so each message states exactly one form. */
const WRITE_VERBS = {
  create: { present: "Writing", past: "Wrote", infinitive: "write" },
  update: { present: "Updating", past: "Updated", infinitive: "update" },
} as const;

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
      return runEventAction(eventStore, params, eventContext);
    },
  };

  return {
    tool,
    setEventContext: (context: EventToolContext) => {
      eventContext = context;
    },
  };
}

/** Dispatch one `event` call; `create` stays the default for older callers. */
async function runEventAction(
  eventStore: EventStore,
  params: EventToolParams,
  context: EventToolContext,
): Promise<EventToolResult> {
  const action = params.action ?? "create";

  if (action === "list") return listEvents(eventStore, params, context);
  if (action === "read") {
    return textResult(JSON.stringify(await eventStore.read(requireFilename(params)), null, 2));
  }
  if (action === "delete") {
    const filename = requireFilename(params);
    await eventStore.delete(filename);
    return textResult(`Deleted event ${filename}`);
  }
  return writeEvent(eventStore, action, params, context);
}

async function listEvents(
  eventStore: EventStore,
  params: EventToolParams,
  context: EventToolContext,
): Promise<EventToolResult> {
  const all = params.scope === "all";
  const listed = await eventStore.list();
  const events = all ? listed : listed.filter((event) => isOwnEvent(event.payload, context));
  const conversationId = all ? undefined : context.conversationId;
  return textResult(
    JSON.stringify({ scope: all ? "all" : "conversation", conversationId, events }, null, 2),
  );
}

/**
 * An event belongs to this conversation when the raw id matches on the same
 * platform. The same raw id on another platform is another office; files
 * written before payloads carried a platform stay visible.
 */
function isOwnEvent(payload: EventPayload | null, context: EventToolContext): boolean {
  if (payload?.conversationId !== context.conversationId) return false;
  return payload.platform === undefined || payload.platform === context.platform;
}

async function writeEvent(
  eventStore: EventStore,
  action: "create" | "update",
  params: EventToolParams,
  context: EventToolContext,
): Promise<EventToolResult> {
  const payload = buildToolEventPayload(params, context);
  const filename =
    action === "update"
      ? requireFilename(params)
      : `${sanitizeFileSegment(params.filenamePrefix || payload.type || "event")}-${Date.now()}.json`;
  const verbs = WRITE_VERBS[action];

  log.logInfo(
    `${verbs.present} event file via control plane store: ${filename} (type=${payload.type}, platform=${payload.platform}, conversation=${payload.conversationId})`,
  );

  try {
    const result =
      action === "update"
        ? await eventStore.update(filename, payload)
        : await eventStore.write(filename, payload);
    log.logInfo(
      `${verbs.past} event file via control plane store: ${result.path} (${result.size} bytes)`,
    );
  } catch (err) {
    log.logWarning(
      `Failed to ${verbs.infinitive} event file via control plane store: ${filename}`,
      String(err),
    );
    throw err;
  }

  return textResult(formatEventWriteResult(action, filename, payload));
}

function buildToolEventPayload(params: EventToolParams, context: EventToolContext): EventPayload {
  if (!params.type) {
    throw new Error("`type` is required for create and update actions");
  }
  if (!params.text) {
    throw new Error("`text` is required for create and update actions");
  }

  // Per-type field rules live in buildEventPayload above. No sessionKey or
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

function sanitizeFileSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "event";
}
