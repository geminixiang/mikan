# src/sessions

This directory manages synchronization between chat history and harness session files, plus session policy, lineage, and metadata.

Session files live in the office's `sessions/` directory, and per-key runtime
state is office-keyed — but the **session key itself stays a raw platform
value** (`conversationId[":"suffix]`). Office keys name directories; session
keys name conversations as the platform reports them.

Session files use Pi 0.85's current v4 JSONL format, whose persisted header
has `v: 4` and `storageVersion: 1`. mikan-specific metadata is a durable
namespaced value under `mikan/metadata`, not a header field. Runtime opening
accepts only this current format; legacy mikan v3 and Pi 0.84-generation v4
files are handled by the offline `mikan sessions migrate` command.

## Keeping up with Pi

Session integration must stay easy to upgrade: use Pi's public session/harness
interfaces, not private `dist` imports, copied execution logic, or speculative
compatibility layers. Pi owns entries, transactions, live compaction, and recovery;
mikan owns Office paths, platform history, and resource lifetime.

Two small format-dependent readers remain because Pi 0.86 does not publicly
export its JSONL header codec or session context projector:

- The synchronous header/metadata reader serves path and lineage
  callers. Storage version and metadata types come from Pi's public exports;
  the JSONL envelope stays local until Pi exposes it.
- The read-only context projection serves inspection and mikan's transcript
  view, never the LLM execution loop. `session-file-store.test.ts` compares it
  with a real Pi harness's `transform_context` input, including compaction and
  excluded assistant messages. Replace it with a public upstream projector
  when one becomes available; do not add a private-import workaround.

Tests seed structural entries through Pi's public mutation interface. There is
no production `appendCompaction()` helper solely for test fixture construction.

## Contracts

- `ChatHistorySync` reads the platform `log.jsonl`, skipping malformed lines and coalescing consecutive bot chunks that share a `ts`, because one streamed response is logged in pieces. Command recognition is injected (`isCommandText`).
- `history-line.ts` owns the prompt history-line grammar `[timestamp] [user] [in-thread:ts]: text`; its writer and parser are round-trip tested.
- `session-key.ts` owns the session-key grammar. Nothing else may split on `:`, and conversation ids never contain `:`.
- `SessionStore` holds the single live-writer lease for a session file. Closing disposes MCP connections, then the harness, Session, repository, and writer lease; a cleanup failure never skips writer release, and `close()` is single-flight. Runner construction closes the writer before reporting a later materialization failure, so the same session can be rebuilt immediately.
- A thread's parent is the main session that was current at the thread's timestamp, stable across `/new`, recorded as `parentSession` + `parentSessionId`.
- The offline migrations verify each result before swapping it in, hard-link the original as `*.v3.bak` or `*.pi-084.bak`, and leave the original in place on any failure.
