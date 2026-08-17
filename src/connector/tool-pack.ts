import { Type, type Static } from "@sinclair/typebox";
import { defineHostFnTool } from "../tools/host-fn-tool.js";
import type { PlatformToolPack, PlatformToolRunContext } from "../tools/types.js";
import type { CuratedActionName } from "./gateway.js";

/** Host-side execution bound per run; principal resolution stays host code. */
export interface ConnectorToolOps {
  execute(
    ctx: PlatformToolRunContext,
    action: CuratedActionName,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string>;
}

type ConnectorFn = (
  action: CuratedActionName,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<string>;

const gwsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("gmail_search"),
      Type.Literal("gmail_read_thread"),
      Type.Literal("calendar_list_events"),
      Type.Literal("sheets_read_range"),
    ],
    {
      description:
        "gmail_search: search mail threads (query). gmail_read_thread: read one " +
        "thread (threadId). calendar_list_events: list calendar events " +
        "(calendarId, optionally timeMin/timeMax/query). sheets_read_range: read " +
        "a spreadsheet range (spreadsheetId, range).",
    },
  ),
  query: Type.Optional(
    Type.String({ description: "gmail_search / calendar_list_events: full-text search query." }),
  ),
  threadId: Type.Optional(Type.String({ description: "gmail_read_thread: Gmail thread ID." })),
  calendarId: Type.Optional(
    Type.String({ description: "calendar_list_events: calendar ID (default: primary)." }),
  ),
  timeMin: Type.Optional(
    Type.String({ description: "calendar_list_events: RFC 3339 lower bound on event time." }),
  ),
  timeMax: Type.Optional(
    Type.String({ description: "calendar_list_events: RFC 3339 upper bound on event time." }),
  ),
  maxResults: Type.Optional(
    Type.Number({ description: "gmail_search / calendar_list_events: maximum results." }),
  ),
  spreadsheetId: Type.Optional(Type.String({ description: "sheets_read_range: spreadsheet ID." })),
  range: Type.Optional(
    Type.String({ description: "sheets_read_range: A1 range, e.g. Sheet1!A1:C10." }),
  ),
});

const githubSchema = Type.Object({
  action: Type.Union([Type.Literal("whoami"), Type.Literal("my_repositories")], {
    description:
      "whoami: the connected GitHub account's profile. my_repositories: " +
      "repositories the connected account can access.",
  }),
});

function requireField(args: Record<string, unknown>, field: string, action: string): string {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`connector: '${field}' is required for action '${action}'`);
  }
  return value;
}

function buildGwsRequest(args: Static<typeof gwsSchema>): {
  action: CuratedActionName;
  input: Record<string, unknown>;
} {
  switch (args.action) {
    case "gmail_search":
      return {
        action: "gmail_search",
        input: {
          query: requireField(args, "query", args.action),
          ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}),
        },
      };
    case "gmail_read_thread":
      return {
        action: "gmail_read_thread",
        input: { threadId: requireField(args, "threadId", args.action) },
      };
    case "calendar_list_events":
      return {
        action: "calendar_list_events",
        input: {
          calendarId: args.calendarId?.trim() || "primary",
          singleEvents: true,
          ...(args.query !== undefined ? { q: args.query } : {}),
          ...(args.timeMin !== undefined ? { timeMin: args.timeMin } : {}),
          ...(args.timeMax !== undefined ? { timeMax: args.timeMax } : {}),
          ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}),
        },
      };
    case "sheets_read_range":
      return {
        action: "sheets_read_range",
        input: {
          spreadsheetId: requireField(args, "spreadsheetId", args.action),
          range: requireField(args, "range", args.action),
        },
      };
  }
}

/**
 * Connector capability pack: host-side, read-only provider actions executed
 * through the Open Connector gateway. Unlike guest CLI credentials, no
 * provider token is materialized anywhere the agent can read — the tools
 * return action results only. Available on every platform; execution fails
 * with a clear "not connected" message until the conversation's principal
 * authorizes a connection via the login portal.
 */
export function createConnectorToolPack(ops: ConnectorToolOps): PlatformToolPack {
  const gws = defineHostFnTool<ConnectorFn, typeof gwsSchema>({
    name: "connector_gws",
    description:
      "Read Google Workspace data (Gmail, Calendar, Sheets) through the host-side " +
      "connector gateway using this conversation's authorized Google account. " +
      "Read-only; credentials never enter the sandbox.",
    parameters: gwsSchema,
    unavailable: "connector_gws is not available: the connector gateway is not configured.",
    run: async (fn, args, signal) => {
      const request = buildGwsRequest(args);
      const text = await fn(request.action, request.input, signal);
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });

  const github = defineHostFnTool<ConnectorFn, typeof githubSchema>({
    name: "connector_github",
    description:
      "Read the connected personal GitHub account (profile, accessible repositories) " +
      "through the host-side connector gateway. Distinct from the platform github_* " +
      "tools, which act as the GitHub App.",
    parameters: githubSchema,
    unavailable: "connector_github is not available: the connector gateway is not configured.",
    run: async (fn, args, signal) => {
      const action: CuratedActionName =
        args.action === "whoami" ? "github_whoami" : "github_my_repositories";
      const text = await fn(action, {}, signal);
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });

  return {
    tools: [gws.tool, github.tool],
    bindRun(ctx) {
      const bound: ConnectorFn = (action, input, signal) => ops.execute(ctx, action, input, signal);
      gws.setFn(bound);
      github.setFn(bound);
    },
  };
}
