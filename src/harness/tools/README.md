# src/harness/tools

This directory contains the platform-neutral tools mikan exposes to the agent.
Platform-specific tools live with their adapter (`adapters/slack/tools/`,
`adapters/github/tools/`) and reach the agent as a `PlatformToolPack`.

## Files

- `attach.ts`: Defines the platform-neutral `attach` tool and binds uploads through the active responder.
- `event.ts`: Defines the agent-facing `event` tool. The scheduled-event protocol, store, and watcher belong to `src/events/`.
- `generate-image.ts`: Defines the `generate_image` tool. It writes host-side into the office directory — the only host location the guest can also reach — and uploads from that host path directly, because the file may not be mounted in the sandbox the way `attach` assumes.
- `host-fn-tool.ts`: `defineHostFnTool` — the shared choreography for a tool whose implementation is injected per run (holder + setter pair, disabled-tool error, abort guard), so a host-backed tool module only states its schema and run body.
- `index.ts`: Assembles core tools — pi-native `read`/`write`/`edit`/`bash` plus mikan's event, sandbox, attach, react, and optional generate_image — exports the separately wired subagent tool factory, and merges optional `PlatformToolPack`s.
- `pi-tools.ts`: The mikan adaptation layer over pi-agent-core's native `read`/`write`/`edit`/`bash`: adds the `label` parameter, pins the bash cwd to the sandbox env, and adapts mikan's own `AgentTool`s into harness tools. The sandbox-backed `ExecutionEnv` they run against is `harness/execution-env.ts`.
- `react.ts`: Defines the `react` tool (a `host-fn-tool`), which reacts to a message with an emoji through the platform bot.
- `sandbox.ts`: Defines the `sandbox` tool for inspecting or changing managed sandbox resource limits.
- `subagent.ts`: Defines the `subagent` tool, which runs one fresh in-memory subagent, a bounded parallel `tasks[]` batch, or a small dependency DAG with explicit tools and budgets; node state streams through `AgentTool.onUpdate`. This module also owns the progress protocol: snapshot bounds, parsing, merging, settling, and canonical Markdown dashboard rendering consumed by the agent presenter.
- `types.ts`: The tool-side contracts for platform capability injection — `PlatformToolPack`, `PlatformToolPackFactory`, and `PlatformToolRunContext`.
