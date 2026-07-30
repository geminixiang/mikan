# src/tools

This directory contains the platform-neutral tools mikan exposes to the agent.
Platform-specific tools live with their adapter (`adapters/slack/tools/`,
`adapters/github/tools/`) and reach the agent as a `PlatformToolPack`.

## Files

- `bash.ts`: Defines the `bash` tool, which runs shell commands through an executor and truncates oversized output, spilling the full text into the runtime workspace (`.mikan/bash-output/`) via `executor.writeFile` so the advertised path is readable where the agent actually runs.
- `edit.ts`: Defines the `edit` tool, which performs exact text replacements through the executor's file transport (`readFile`/`writeFile` — file contents never pass through shell argv).
- `event.ts`: Defines the `event` tool, which writes reminder/scheduled-event JSON into the host-side events directory.
- `generate-image.ts`: Defines the `generate_image` tool. It writes host-side into the office directory — the only host location the guest can also reach — and uploads from that host path directly, because the file may not be mounted in the sandbox the way `attach` assumes.
- `host-fn-tool.ts`: `defineHostFnTool` — the shared choreography for a tool whose implementation is injected per run (holder + setter pair, disabled-tool error, abort guard), so a host-backed tool module only states its schema and run body.
- `index.ts`: Assembles core tools (read, bash, edit, write, event, sandbox, attach, react, and optionally generate_image), exports the separately wired subagent tool factory and the global slot pool, and merges optional `PlatformToolPack`s.
- `react.ts`: Defines the `react` tool (a `host-fn-tool`), which reacts to a message with an emoji through the platform bot.
- `read.ts`: Defines the `read` tool, which reads text or images with offset, limit, and truncation support.
- `sandbox.ts`: Defines the `sandbox` tool for inspecting or changing managed sandbox resource limits.
- `subagent.ts`: Defines the `subagent` tool, which runs one fresh in-memory subagent, a bounded parallel `tasks[]` batch, or a small dependency DAG with explicit tools and budgets; node state streams through `AgentTool.onUpdate`.
- `subagent-slots.ts`: `SubagentSlotPool` — the process-wide fan-out ceiling (`DEFAULT_GLOBAL_SUBAGENT_SLOTS`). Per-run caps alone would let N busy conversations hold N × cap live subagent sessions, so every launch also draws from this shared pool.
- `types.ts`: The tool-side contracts — `PlatformToolPack` / `PlatformToolPackFactory` / `PlatformToolRunContext`, the event store interface, and the truncation option/result shapes.
- `write.ts`: Defines the `write` tool, which writes file content (parent directories included) through `executor.writeFile`.
