import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import * as log from "../log.js";
import type { McpLoadError, McpServerConfig, McpToolsResult } from "./types.js";

export type { McpServerConfig, McpToolsResult } from "./types.js";

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;

/** Server names become tool-name segments; keep them to a safe charset so a
 *  settings typo cannot produce an unparseable or provider-rejected tool name. */
const SERVER_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function buildTransport(name: string, config: McpServerConfig) {
  if (config.command && config.url) {
    throw new Error(`server "${name}" sets both command and url; pick one transport`);
  }
  if (config.command) {
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      // The SDK's default env is a minimal safe allowlist (PATH, HOME…);
      // entries from settings are merged over it. Credentials for the MCP
      // server belong here — on the host, out of the model's reach.
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: "ignore",
    });
  }
  if (config.url) {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    });
  }
  throw new Error(`server "${name}" sets neither command nor url`);
}

function toAgentToolResult(result: {
  content?: unknown;
  isError?: boolean;
}): AgentToolResult<undefined> {
  const parts = Array.isArray(result.content) ? result.content : [];
  const content: AgentToolResult<undefined>["content"] = [];
  for (const part of parts) {
    if (part && typeof part === "object" && "type" in part) {
      if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
        content.push({ type: "text", text: (part as { text: string }).text });
        continue;
      }
      if (
        part.type === "image" &&
        typeof (part as { data?: unknown }).data === "string" &&
        typeof (part as { mimeType?: unknown }).mimeType === "string"
      ) {
        const image = part as { data: string; mimeType: string };
        content.push({ type: "image", data: image.data, mimeType: image.mimeType });
        continue;
      }
      // resource/audio/other parts: surface as JSON text rather than dropping.
      content.push({ type: "text", text: JSON.stringify(part) });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "(empty result)" });
  }
  const text = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  if (result.isError) {
    // AgentTool contract: throw on failure instead of encoding errors in content.
    throw new Error(text || "MCP tool call failed");
  }
  return { content, details: undefined };
}

async function connectServer(
  name: string,
  config: McpServerConfig,
): Promise<{ client: Client; tools: AgentTool<TSchema>[] }> {
  const client = new Client({ name: "mikan", version: "1.0.0" });
  const transport = buildTransport(name, config);
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
  const tools: AgentTool<TSchema>[] = listed.tools.map((mcpTool) => ({
    // Server prefix keeps names collision-free and visibly foreign next to
    // mikan's own tools: `mcp__github__create_issue`.
    name: `mcp__${name}__${mcpTool.name}`,
    label: `${name}: ${mcpTool.name}`,
    description: mcpTool.description ?? `${mcpTool.name} (MCP server "${name}")`,
    // MCP inputSchema is JSON Schema with `"type": "object"` at the root —
    // structurally a valid TSchema; the provider sees the same JSON either way.
    parameters: mcpTool.inputSchema as unknown as TSchema,
    execute: async (_toolCallId, params, signal) => {
      const result = await client.callTool(
        { name: mcpTool.name, arguments: params as Record<string, unknown> },
        undefined,
        { timeout: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      return toAgentToolResult(result as { content?: unknown; isError?: boolean });
    },
  }));
  return { client, tools };
}

/**
 * Connect to every enabled MCP server and wrap their tools as mikan
 * {@link AgentTool}s. Failures are per-server: one unreachable server
 * reports an error and the rest still load. Callers own the returned
 * `dispose` and must call it when the runner is disposed, or stdio child
 * processes leak.
 */
export async function loadMcpTools(
  servers: Record<string, McpServerConfig>,
): Promise<McpToolsResult> {
  const clients: Client[] = [];
  const tools: AgentTool<TSchema>[] = [];
  const errors: McpLoadError[] = [];

  const entries = Object.entries(servers).filter(([, config]) => !config.disabled);
  const results = await Promise.allSettled(
    entries.map(async ([name, config]) => {
      if (!SERVER_NAME_RE.test(name)) {
        throw new Error(
          `server name "${name}" is invalid: use letters, digits, "_" or "-", starting with a letter`,
        );
      }
      return { name, ...(await connectServer(name, config)) };
    }),
  );
  for (const [index, result] of results.entries()) {
    const name = entries[index]![0];
    if (result.status === "rejected") {
      errors.push({ server: name, error: String(result.reason?.message ?? result.reason) });
      continue;
    }
    clients.push(result.value.client);
    tools.push(...result.value.tools);
  }

  return {
    tools,
    errors,
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
