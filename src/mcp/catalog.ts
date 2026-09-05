import type { McpPreset, McpServerConfig } from "./types.js";

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
    ...(preset.server.args ? { args: [...preset.server.args] } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}
