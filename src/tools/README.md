# src/tools

This directory contains tools exposed by mikan to the agent.

## Files

- `bash.ts`: Defines the `bash` tool, which runs shell commands through an executor and truncates oversized output, spilling the full text into the runtime workspace (`.mikan/bash-output/`) via `executor.writeFile` so the advertised path is readable where the agent actually runs.
- `edit.ts`: Defines the `edit` tool, which performs exact text replacements through the executor's file transport (`readFile`/`writeFile` — file contents never pass through shell argv).
- `event.ts`: Defines the `event` tool, which writes reminder/scheduled-event JSON into the host-side events directory.
- `index.ts`: Assembles core tools (read, bash, edit, write, event, sandbox, attach, react) and merges optional `PlatformToolPack`s.
- `github-pr.ts` / `github-checks.ts`: GitHub host tools; wired via `adapters/github/tool-pack.ts`, not always registered in core.
- `read.ts`: Defines the `read` tool, which reads text or images with offset, limit, and truncation support.
- `sandbox.ts`: Defines the `sandbox` tool for inspecting or changing managed sandbox resource limits.
- `truncate.ts`: Provides line/byte truncation and size-formatting helpers.
- `write.ts`: Defines the `write` tool, which writes file content (parent directories included) through `executor.writeFile`.
