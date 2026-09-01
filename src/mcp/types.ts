import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";

/**
 * MCP (Model Context Protocol) server configuration and load results.
 *
 * A server entry is either stdio (`command` + optional `args`/`env`) or
 * streamable HTTP (`url` + optional `headers`). Exactly one of `command`
 * or `url` must be set — the settings schema keeps both optional so the
 * file stays object-rooted and forgiving; `loadMcpTools` enforces the
 * exclusivity at runtime.
 *
 * Credentials (API keys in `env`/`headers`) stay in host-side settings and
 * the MCP server process; the model sees only tool names and schemas.
 */
export interface McpServerConfig {
  /** stdio transport: executable to spawn on the host. */
  command?: string;
  args?: string[];
  /** Extra environment for the spawned server, merged over a safe default. */
  env?: Record<string, string>;
  /** streamable-HTTP transport: server endpoint URL. */
  url?: string;
  headers?: Record<string, string>;
  /** Disable without deleting — lets a conversation turn off a global server. */
  disabled?: boolean;
}

type McpPresetCredentialTarget = "env" | "header";

interface McpPresetCredential {
  key: string;
  label: string;
  description: string;
  target: McpPresetCredentialTarget;
  required: boolean;
  secret: boolean;
  valuePrefix?: string;
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  category: string;
  serverName: string;
  sourceUrl: string;
  setupUrl: string;
  server: McpServerConfig;
  credentials: McpPresetCredential[];
}

export interface McpLoadError {
  server: string;
  error: string;
}

export interface McpToolsResult {
  /** Tools namespaced `mcp__<server>__<tool>`, ready for the agent tool list. */
  tools: AgentTool<TSchema>[];
  errors: McpLoadError[];
  /** Close all server connections (and kill stdio child processes). */
  dispose: () => Promise<void>;
}
