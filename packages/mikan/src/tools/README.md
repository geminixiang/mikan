# src/tools

This directory contains tools exposed by mikan to the agent.

## Files

- `bash.ts`: Defines the `bash` tool, which runs shell commands through an executor and truncates/saves oversized output.
- `edit.ts`: Defines the `edit` tool, which performs exact text replacements and returns a diff.
- `event.ts`: Defines the `event` tool, which writes reminder/scheduled-event JSON into the host-side events directory.
- `index.ts`: Assembles read, bash, edit, write, event, sandbox, attach, and related tool context setters.
- `read.ts`: Defines the `read` tool, which reads text or images with offset, limit, and truncation support.
- `sandbox.ts`: Defines the `sandbox` tool for inspecting or changing managed sandbox resource limits.
- `truncate.ts`: Provides line/byte truncation and size-formatting helpers.
- `write.ts`: Defines the `write` tool, which creates parent directories and writes file content.
