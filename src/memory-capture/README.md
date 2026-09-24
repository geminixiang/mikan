# src/memory-capture

This module records durable knowledge from finished human runs into the office's conversation `MEMORY.md` ([ADR 0011](../../docs/adr/0011-capture-durable-knowledge-after-runs.md)).

## Contract

- `ConversationRuntime` builds a `RunMemoryCapture` from the optional `memoryCapture` factory and calls `capture()` after every run returns. `main.ts` enables `MemoryCapture`; embedders and tests that omit the factory capture nothing.
- `capture()` never blocks conversation work. It skips runs whose stop reason is not `stop`, runs with an empty message or reply, and scheduled-event runs, using the harness's own `resolveTriggerAttribution` and `isEventTriggerAttribution` so event detection has one definition.
- Captures for one office run strictly in order, so each extraction sees the memory written by the previous one. Different offices proceed independently. A failed capture is logged and does not affect later ones.
- The gate is Jev (`caller: "memory_capture"`) on the user message (first 4,000 characters) and the final assistant reply (last 2,000 characters). Tool results are never sent. Runs scoring below 0.4 end here. `JevNotConfiguredError` disables capture for the rest of the process.
- Extraction is a tool-less `runSubagent` call on the office's configured model and thinking level, with a TypeBox `outputSchema` (at most six `add`/`update` operations) and a budget of one turn, 60 seconds, and $0.50. The subagent runner owns the in-memory session, deadline, abort, and schema validation; any non-`completed` status fails the capture without writing. The input is the current `MEMORY.md` and the same exchange. Secrets, transient state, one-off parameters, and assistant-only claims are excluded by the prompt.
- Before writing, each entry passes through the harness's `redactSecrets`, which replaces any configured secret environment value with `[SECRET:<name>]`, the same scrubbing tool output receives.
- `applyMemoryOps` works on a fresh read of the file just before an atomic replace. Each entry is one line stamped `(captured YYYY-MM-DD from <message id>)`. An `update` replaces the line containing its `replaces` text, or is appended when that line is gone. Additions go at the end of the `## Captured knowledge` section, which is created at the end of the file when missing. Text already present is skipped. Nothing else in the file is rewritten.
- Only the office's own `MEMORY.md` is written; workspace-global memory is never touched. The host log records counts per capture, not entry text.

## Design notes

- `applyMemoryOps` stays local instead of letting the model edit the file with Pi's `edit` tool. Pi's host `ExecutionEnv` does not confine paths to a directory and `runSubagent` does not expose `before_tool`, so a tool-based write would need a new path guard; the local applier also guarantees the stamp and section placement.
- The per-office promise chain follows the same pattern as `SessionLifecycle.enqueue`. That queue is keyed by session and shares run bookkeeping, and `MessagingEventQueue` belongs to the platform adapters, so neither is reused here.

## Limits

- An agent write to `MEMORY.md` landing between the fresh read and the atomic replace can be lost. Captures deliberately do not take the office maintenance barrier, which would hold new work behind unrelated active runs.
- Captures in flight at shutdown are abandoned. Writes are atomic, so the file is never partially written.
- Nothing consolidates or shortens `MEMORY.md` automatically ([ADR 0012](../../docs/adr/0012-remove-dream.md)). Entries accumulate until the agent or a user edits them.

## Files

- `index.ts`: `MemoryCapture`, the Jev gate, subagent extraction and its output schema, and the pure `isCapturableRun` and `applyMemoryOps` helpers.
- `types.ts`: `CapturedRun`, `RunMemoryCapture`, `MemoryCaptureOp`, and the injectable `MemoryCaptureDeps`.
