# src/sessions

This directory manages synchronization between chat history and harness session files, plus session policy, lineage, rotation, and metadata.

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
mikan owns Office paths, platform history, rotation, and resource lifetime.

Two small format-dependent readers remain because Pi 0.86 does not publicly
export its JSONL header codec or session context projector:

- The synchronous header/metadata reader serves path, lineage, and rotation
  callers. Storage version and metadata types come from Pi's public exports;
  the JSONL envelope stays local until Pi exposes it.
- The read-only context projection serves inspection and mikan's transcript
  view, never the LLM execution loop. `session-file-store.test.ts` compares it
  with a real Pi harness's `transform_context` input, including compaction and
  excluded assistant messages. Replace it with a public upstream projector
  when one becomes available; do not add a private-import workaround.

Tests seed structural entries through Pi's public mutation interface. There is
no production `appendCompaction()` helper solely for test fixture construction.

## Files

- `chat-history-sync.ts`: `ChatHistorySync` — synchronizes platform `log.jsonl` into harness sessions and handles channel/thread bootstrap, rebuild, reset, and scope resolution. Also owns the platform-log reader: skips malformed lines and coalesces consecutive bot chunks sharing a `ts`, since one streamed response is logged in pieces.
- `history-line.ts`: Owns the prompt history-line grammar (`[timestamp] [user] [in-thread:ts]: text`) — the timestamp format (`formatLocalTimestamp`), the writer (agent prompts, history replay), and the parser (resume dedupe stripping). Round-trip tested so the two directions cannot drift apart silently.
- `session-key.ts`: Owns the session-key grammar (`conversationId[":"suffix]`) and the policy on top of it: derive/is-thread/conversation-id-of/thread-suffix-of, plus `resolveChatSessionKey` (platform kind × thread flags → key) and `inferConversationKind`. Nothing else may split on `:`; asserts the invariant that conversation ids never contain `:`.
- `session-store.ts`: Owns the current Pi v4 JSONL header format and validation, exact file path, single live-writer lease, lazy materialization, lineage metadata, immutable inspection, native `AgentHarness` attachment, and MCP lifetime. Existing branches are promoted without rewriting history. Closing first disposes MCP connections and then the harness, Session, repository, and writer lease; cleanup failures cannot skip writer release, and `close()` remains single-flight.
- `store.ts`: Decides session file paths and ids, and owns the biweekly rotation clock for top-level shared sessions (a session rotates when its header timestamp falls in a different two-week bucket than now) — creation, the current-session pointer, thread session paths, and archival of a fixed-path scoped session before reset — and opens them through the session-owned `SessionStore`. Runner construction closes that writer before returning any later materialization failure, so the same session can be reconstructed immediately. `isPlatformHistorySession` reads that header to spot history-derived sessions. Also resolves thread→main lineage: `resolveParentSessionForThread` picks the main session that was current at the thread's timestamp (stable across rotations) and records it as `parentSession` + `parentSessionId`, so Session View can walk the tree by id rather than by path.
- `migrate-common.ts`: What both migrations share — candidate discovery, the `V4FileWriter` that numbers v4 mutations, and the verify-then-swap commit that hard-links the original as a backup and leaves it in place on any failure.
- `migrate-v3.ts`: Offline-converts legacy mikan v3 session files to the current Pi v4 format, verifies each result, and preserves the original as `*.v3.bak`.
- `migrate-pi-084.ts`: Offline-converts Pi 0.84-generation v4 session files to the current Pi v4 format, verifies each result, and preserves the original as `*.pi-084.bak`.
- `types.ts`: The module's shared interfaces — session header, session-key options, resolved scopes, log records, and the `ChatHistorySync` option/report bags re-exported by the file that implements each.
