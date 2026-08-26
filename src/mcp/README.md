# src/mcp — MCP client integration

Connects settings-declared [Model Context Protocol](https://modelcontextprotocol.io)
servers and exposes their tools to the agent as `mcp__<server>__<tool>`.

- `loader.ts` — `loadMcpTools(servers)`: connects every enabled server
  (stdio or streamable HTTP), wraps each MCP tool as a mikan `AgentTool`,
  and returns a `dispose` that closes the connections. Per-server failures
  are reported as errors without failing the rest.
- `types.ts` — `McpServerConfig` (the settings shape) and result types.

Servers run host-side: credentials in `env`/`headers` live in settings and
the server process, out of the model's and the sandbox's reach. This is the
sanctioned path for "let the agent use service X" — instead of putting a raw
API key where the model can read it (see ADR 0006).

Configuration merge (global + per-conversation, per server name) is owned by
`src/config.ts`; the admin portal's MCP panels edit each scope's raw map.
Runner wiring lives in `src/agent/runner.ts`: tools are connected when a
runner is built and disposed with it, so settings changes apply on the next
runner build (`settings-mutation.ts` refreshes caches on `mcpServers` patches).
