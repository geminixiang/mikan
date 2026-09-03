# src/mcp — MCP client integration

Connects settings-declared [Model Context Protocol](https://modelcontextprotocol.io)
servers and exposes their tools to the agent as `mcp__<server>__<tool>`.

- `catalog.ts` — the repository-owned reviewed preset catalog and the single
  materializer from a preset plus administrator-entered credentials to the
  existing `McpServerConfig` settings shape. Presets pin local package versions.
- `loader.ts` — `loadMcpTools(servers)`: connects every enabled server
  (stdio or streamable HTTP), wraps each MCP tool as a mikan `AgentTool`,
  retains server-provided operating instructions for the system prompt, and
  returns a `dispose` that closes the connections. Per-server failures are
  reported as errors without failing the rest.
- `types.ts` — `McpServerConfig` (the settings shape) and result types.

Servers run host-side: credentials in `env`/`headers` live in settings and
the server process, out of the model's and the sandbox's reach. This is the
sanctioned path for "let the agent use service X" — instead of putting a raw
API key where the model can read it.

The OpenConnector preset targets a self-hosted sibling runtime at
`http://127.0.0.1:3737/mcp`. OpenConnector retains shared provider credentials
and executes connected actions on the host side; mikan receives only its five
MCP meta-tools. When `OPENCONNECTOR_ORIGIN` and
`OPENCONNECTOR_ADMIN_TOKEN` are set, the runner provisions one persistent
runtime token per Slack Conversation office, named
`mikan:slack:<workspace-id>:<channel-id>`, and stores it under the office's
host-private State-dir. The deployment-owned origin is the only destination
that may receive the admin token; conversation MCP URL overrides cannot redirect
it. The admin token is used only by this host provisioning boundary and never
enters settings or the Sandbox Vault. Managed sandboxes do
not receive it; host mode remains an explicitly trusted, non-isolated mode.
Provisioning failure disables only OpenConnector for that runner. Without the
env var, the preset keeps using its administrator-installed runtime token.
OpenConnector calls are stateless across channel and thread runners. When
`get_action_guide` or `execute_action` omits `connectionName`, mikan queries the
action's service and fills the name only if exactly one connection exists;
multiple-account selection remains explicit.

Configuration merge (global + per-conversation, per server name) is owned by
`src/config.ts`; the admin portal's MCP panels edit each scope's raw map. The
Marketplace is only a reviewed discovery and installation surface: installation
materializes a preset into that same map, and installed state has no second
record or database.
Runner wiring lives in `src/agent/runner.ts`: tools are connected when a
runner is built and disposed with it, so settings changes apply on the next
runner build (`settings-mutation.ts` refreshes caches on `mcpServers` patches).
The runner's required platform trust gate runs before OpenConnector provisioning:
`membership` preserves the configured MCP map and provisioning, while
`open-trigger` unconditionally replaces the effective map with `{}`. Open-trigger
runners therefore neither launch configured servers nor admit MCP tools or server
instructions into the parent or subagent sessions.

Preset installation is administrator-only and requires a preview/confirmation
in the Admin portal. A local preset executes its pinned command on the mikan
host; a remote preset sends tool calls and selected data to its fixed origin.
Catalog inclusion is review, not a security certification. Credentials continue
to live directly in host-private settings and Admin responses expose only their
key names.
