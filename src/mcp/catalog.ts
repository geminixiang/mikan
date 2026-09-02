import type { McpPreset, McpServerConfig } from "./types.js";

const MCP_PRESETS: readonly McpPreset[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Work with repositories, issues, pull requests, code, and GitHub Actions.",
    category: "Development",
    serverName: "github",
    sourceUrl: "https://github.com/github/github-mcp-server",
    setupUrl: "https://github.com/github/github-mcp-server#remote-github-mcp-server",
    server: { url: "https://api.githubcopilot.com/mcp/" },
    credentials: [
      {
        key: "Authorization",
        label: "GitHub personal access token",
        description: "A GitHub PAT with only the repository permissions you want mikan to use.",
        target: "header",
        required: true,
        secret: true,
        valuePrefix: "Bearer ",
      },
    ],
  },
  {
    id: "context7",
    name: "Context7",
    description: "Look up current, version-specific library and framework documentation.",
    category: "Documentation",
    serverName: "context7",
    sourceUrl: "https://github.com/upstash/context7",
    setupUrl: "https://context7.com/docs/resources/all-clients",
    server: { url: "https://mcp.context7.com/mcp" },
    credentials: [
      {
        key: "Authorization",
        label: "Context7 API key",
        description: "Create an API key in Context7 and paste the raw key here.",
        target: "header",
        required: true,
        secret: true,
        valuePrefix: "Bearer ",
      },
    ],
  },
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
  {
    id: "playwright",
    name: "Playwright",
    description: "Inspect and automate websites through Playwright's accessibility-first tools.",
    category: "Browser",
    serverName: "playwright",
    sourceUrl: "https://github.com/microsoft/playwright-mcp",
    setupUrl: "https://github.com/microsoft/playwright-mcp#installation",
    server: { command: "npx", args: ["-y", "@playwright/mcp@0.0.80"] },
    credentials: [],
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "Add a structured tool for revising and branching through complex reasoning.",
    category: "Reasoning",
    serverName: "sequential-thinking",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    setupUrl:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking#usage-with-claude-desktop",
    server: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2026.8.31"],
    },
    credentials: [],
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
