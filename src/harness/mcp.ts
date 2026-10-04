import type {
  McpExposure,
  McpPreset,
  McpServerConfig,
  McpServerSummary,
  McpLoadError,
  McpToolsResult,
} from "./types.js";
import {
  McpClient,
  McpHttpError,
  StdioTransport,
  StreamableHttpTransport,
  type McpTransport,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import type { MikanHarnessTool } from "./types.js";
import { guardMcpToolResult } from "./mcp-result.js";
import { tagHarnessTool } from "./tools/pi-tools.js";
import { TOOL_SEARCH_TOOL } from "./tools/tool-search.js";
import { LABEL_PARAMETER } from "./tools/host-fn-tool.js";
import { Type, type TSchema } from "typebox";

import { readStandardEnv } from "../env-manifest.js";
import * as log from "../log.js";
import { errorMessage, isRecord } from "../unknown-values.js";

const SERVER_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name);
}

export type StandardMcpParseResult =
  | { servers: Record<string, McpServerConfig>; error?: undefined }
  | { servers?: undefined; error: string };

export function parseStandardMcpServers(text: string): StandardMcpParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `not valid JSON: ${errorMessage(err)}` };
  }
  if (!isRecord(parsed)) return { error: "expected a JSON object at the top level" };
  const map = "mcpServers" in parsed ? parsed.mcpServers : parsed;
  if (!isRecord(map)) return { error: '"mcpServers" must be an object keyed by server name' };
  if (Object.keys(map).length === 0) return { error: "no servers found in the pasted JSON" };
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(map)) {
    if (!isValidMcpServerName(name)) {
      return {
        error: `invalid server name "${name}" (letters, digits, '_' or '-', starting with a letter)`,
      };
    }
    if (!isRecord(entry)) return { error: `"${name}" must be an object` };
    const hasCommand = typeof entry.command === "string" && entry.command.trim() !== "";
    const hasUrl = typeof entry.url === "string";
    if (hasUrl && !URL.canParse(entry.url as string)) {
      return { error: `"${name}": url is not a valid URL` };
    }
    if (hasCommand === hasUrl) {
      const detail = hasCommand
        ? "set only one of command / url"
        : "set either command (stdio) or url (HTTP)";
      return { error: `"${name}": ${detail}` };
    }
    servers[name] = {
      command: hasCommand ? (entry.command as string) : undefined,
      args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
      env: isRecord(entry.env) ? stringValues(entry.env) : undefined,
      url: hasUrl ? (entry.url as string) : undefined,
      headers: isRecord(entry.headers) ? stringValues(entry.headers) : undefined,
      disabled: entry.disabled === true ? true : undefined,
      exposure: entry.exposure === "deferred" ? "deferred" : undefined,
      description: typeof entry.description === "string" ? entry.description : undefined,
    };
  }
  return { servers };
}

function stringValues(map: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, String(v)]));
}

export function redactMcpUrl(url: string): string {
  if (!URL.canParse(url)) return url.replace(/([?&][^=&]+=)[^&]*/g, "$1<redacted>");
  const parsed = new URL(url);
  if (!parsed.search) return url;
  const keys = new Set(parsed.searchParams.keys());
  for (const key of keys) parsed.searchParams.set(key, "<redacted>");
  return parsed.toString().replace(/%3Credacted%3E/g, "<redacted>");
}

const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: "metabase",
    name: "Metabase",
    description: "Query and explore analytics from your Metabase instance.",
    category: "Analytics",
    serverName: "metabase",
    sourceUrl: "https://github.com/metabase/metabase",
    setupUrl: "https://www.metabase.com/docs/latest/ai/mcp",
    server: { url: "https://{your-metabase.example.com}/api/metabase-mcp" },
    credentials: [
      {
        key: "url",
        label: "Metabase MCP server URL",
        description:
          "The full endpoint, for example https://metabase.example.com/api/metabase-mcp.",
        target: "url",
        required: true,
        secret: false,
      },
      {
        key: "x-api-key",
        label: "Metabase API key",
        description:
          "An API key whose Metabase permissions match the access you want mikan to have.",
        target: "header",
        required: true,
        secret: true,
      },
    ],
  },
];

export function listMcpPresets(): readonly McpPreset[] {
  return MCP_PRESETS;
}

export function findMcpPreset(id: string): McpPreset | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}

export function materializeMcpPreset(
  preset: McpPreset,
  values: Record<string, string>,
): McpServerConfig {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  let url = preset.server.url;
  for (const credential of preset.credentials) {
    const value = values[credential.key]?.trim() ?? "";
    if (!value) {
      if (credential.required) throw new Error(`${credential.label} is required`);
      continue;
    }
    const formatted = `${credential.valuePrefix ?? ""}${value}`;
    if (credential.target === "env") env[credential.key] = formatted;
    else if (credential.target === "header") headers[credential.key] = formatted;
    else {
      if (!URL.canParse(formatted) || !/^https?:/.test(new URL(formatted).protocol)) {
        throw new Error(`${credential.label} must be a valid HTTP URL`);
      }
      url = formatted;
    }
  }
  return {
    ...preset.server,
    args: preset.server.args ? [...preset.server.args] : undefined,
    url,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

const CONNECT_TIMEOUT_MS = 15_000;

const CALL_TIMEOUT_MS = 120_000;

const INHERITED_ENV_KEYS = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    INHERITED_ENV_KEYS.flatMap((key) => {
      const value = readStandardEnv(key);
      return value === undefined || value.startsWith("()") ? [] : [[key, value]];
    }),
  );
}

const ERROR_BODY_CHARS = 300;

function describeLoadError(error: unknown): string {
  const message = errorMessage(error);
  if (!(error instanceof McpHttpError)) return message;
  const body = error.body.trim().slice(0, ERROR_BODY_CHARS);
  if (!body || message.includes(body.slice(0, 40))) return message;
  return `${message} (HTTP ${error.status}): ${body}`;
}

function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function buildTransport(name: string, config: McpServerConfig): McpTransport {
  if (config.command && config.url) {
    throw new Error(`server "${name}" sets both command and url; pick one transport`);
  }
  if (config.command) {
    return new StdioTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...inheritedEnvironment(), ...config.env },
      inheritEnv: false,
      stderr: "pipe",
    });
  }
  if (config.url) {
    return new StreamableHttpTransport({ url: config.url, headers: config.headers });
  }
  throw new Error(`server "${name}" sets neither command nor url`);
}

async function connectServer(
  name: string,
  config: McpServerConfig,
  signal?: AbortSignal,
): Promise<{ client: McpClient; tools: MikanHarnessTool[]; instructions?: string }> {
  const exposure: McpExposure = config.exposure ?? "codemode";
  const client = new McpClient({
    name: "mikan",
    version: "1.0.0",
    requestTimeoutMs: CONNECT_TIMEOUT_MS,
  });
  try {
    await untilAborted(client.connect(buildTransport(name, config)), signal);
    const listed = await client.listTools({ timeoutMs: CONNECT_TIMEOUT_MS, signal });
    const tools: MikanHarnessTool[] = listed.map((mcpTool) => {
      const ownsLabel = Object.hasOwn(schemaProperties(mcpTool.inputSchema), "label");
      return tagHarnessTool({
        name: `mcp__${name}__${mcpTool.name}`,
        exposure,
        namespace: name,
        description: mcpTool.description ?? `${mcpTool.name} (MCP server "${name}")`,
        parameters: ownsLabel ? mcpTool.inputSchema : withLabelParameter(mcpTool.inputSchema),
        outputSchema: mcpResultSchema(mcpTool.outputSchema),
        execute: async (params, api, context) => {
          const result = await client.callTool(
            mcpTool.name,
            ownsLabel ? (params as Record<string, unknown>) : withoutLabel(params),
            { timeoutMs: CALL_TIMEOUT_MS, signal: context.abortSignal },
          );
          return guardMcpToolResult(result, api.env, context);
        },
      });
    });
    const instructions = client.instructions?.trim();
    return { client, tools, instructions: instructions || undefined };
  } catch (error) {
    try {
      await client.close();
    } catch (closeError) {
      log.logWarning("MCP client rollback failed", String(closeError));
    }
    throw error;
  }
}

type McpInputSchema = McpTool["inputSchema"];

function schemaProperties(schema: McpInputSchema): Record<string, unknown> {
  return isRecord(schema.properties) ? schema.properties : {};
}

function withLabelParameter(schema: McpInputSchema): McpInputSchema {
  const required = Array.isArray(schema.required) ? schema.required : [];
  return {
    ...schema,
    type: "object",
    properties: { label: LABEL_PARAMETER, ...schemaProperties(schema) },
    required: ["label", ...required],
  };
}

function withoutLabel(params: unknown): Record<string, unknown> {
  if (!isRecord(params)) return {};
  const { label: _label, ...rest } = params;
  return rest;
}

function mcpResultSchema(structuredContent: Record<string, unknown> | undefined): TSchema {
  return Type.Object({
    content: Type.Array(Type.Object({})),
    ...(structuredContent
      ? { structuredContent: Type.Optional(Type.Unsafe(structuredContent)) }
      : {}),
    isError: Type.Optional(Type.Boolean()),
    _meta: Type.Optional(Type.Object({})),
  });
}

const MAX_SERVER_SUMMARY_CHARS = 250;
const MAX_SERVERS_SECTION_CHARS = 4096;

function serverReach(server: McpServerSummary): string {
  return server.exposure === "deferred" ? TOOL_SEARCH_TOOL : "codemode";
}

function serverSummary(server: McpServerSummary): string {
  const text = server.description?.trim() || server.instructions?.trim() || "";
  return (text.split("\n", 1)[0] ?? "").trim();
}

function omittedServers(count: number): string[] {
  return count > 0 ? [`- … ${count} more servers; find their tools with searchTools()`] : [];
}

function truncateSummary(text: string, max: number): string {
  if (text.length <= max) return text;
  return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function renderMcpServersSection(servers: readonly McpServerSummary[]): string {
  if (servers.length === 0) return "";
  const listed = servers.toSorted((a, b) => a.name.localeCompare(b.name));
  const reaches = new Set(listed.map(serverReach));
  let intro = "MCP servers whose tools are not declared to you.";
  if (reaches.has("codemode"))
    intro += " Call the tools of `codemode` servers from codemode scripts.";
  if (reaches.has(TOOL_SEARCH_TOOL))
    intro += " Load the tools of `tool_search` servers with `tool_search`.";
  const heads = listed.map((server) => `- mcp__${server.name} (${serverReach(server)})`);
  const size = (kept: number) =>
    [intro, ...heads.slice(0, kept), ...omittedServers(listed.length - kept)].join("\n").length;
  let kept = listed.length;
  while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
  const perServer =
    kept === 0
      ? 0
      : Math.min(
          MAX_SERVER_SUMMARY_CHARS,
          Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2,
        );
  const lines = listed.slice(0, kept).map((server, index) => {
    const summary = perServer > 0 ? truncateSummary(serverSummary(server), perServer) : "";
    return summary ? `${heads[index]}: ${summary}` : heads[index];
  });
  return [intro, ...lines, ...omittedServers(listed.length - kept)].join("\n");
}

export async function loadMcpTools(
  servers: Record<string, McpServerConfig>,
  signal?: AbortSignal,
): Promise<McpToolsResult> {
  const clients: McpClient[] = [];
  const tools: MikanHarnessTool[] = [];
  const errors: McpLoadError[] = [];
  const summaries: McpServerSummary[] = [];

  const entries = Object.entries(servers).filter(([, config]) => !config.disabled);
  const results = await Promise.allSettled(
    entries.map(async ([name, config]) => {
      if (!isValidMcpServerName(name)) {
        throw new Error(
          `server name "${name}" is invalid: use letters, digits, "_" or "-", starting with a letter`,
        );
      }
      return { name, ...(await connectServer(name, config, signal)) };
    }),
  );
  for (const [index, result] of results.entries()) {
    const name = entries[index]![0];
    if (result.status === "rejected") {
      errors.push({ server: name, error: describeLoadError(result.reason) });
      continue;
    }
    clients.push(result.value.client);
    tools.push(...result.value.tools);
    const config = entries[index]![1];
    summaries.push({
      name,
      exposure: config.exposure ?? "codemode",
      description: config.description,
      instructions: result.value.instructions,
    });
  }

  return {
    tools,
    errors,
    servers: summaries,
    dispose: async () => {
      const closes = await Promise.allSettled(clients.map((client) => client.close()));
      for (const close of closes) {
        if (close.status === "rejected") {
          log.logWarning("MCP client close failed", String(close.reason));
        }
      }
    },
  };
}
