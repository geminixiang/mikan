# src/sessions

This directory manages synchronization between chat history and harness session files, plus session policy, lineage, rotation, and metadata.

Session files live in the office's `sessions/` directory, and per-key runtime
state is office-keyed — but the **session key itself stays a raw platform
value** (`conversationId[":"suffix]`). Office keys name directories; session
keys name conversations as the platform reports them.

## Files

- `chat-history-sync.ts`: `ChatHistorySync` — synchronizes platform `log.jsonl` into harness sessions and handles channel/thread bootstrap, rebuild, reset, and scope resolution.
- `conversation-log.ts`: Reads a conversation's platform chat log (`log.jsonl`): skips malformed lines and coalesces consecutive bot chunks sharing a `ts`, since one streamed response is logged in pieces.
- `history-line.ts`: Owns the prompt history-line grammar (`[timestamp] [user] [in-thread:ts]: text`) — both the writer (agent prompts, history replay) and the parser (resume dedupe stripping). Round-trip tested so the two directions cannot drift apart silently.
- `metadata.ts`: Detects sessions derived from platform history by reading the mikan session header.
- `policy.ts`: Derives chat session keys from platform, conversation kind, threads, and root messages.
- `rotation.ts`: The biweekly rotation clock for top-level shared sessions — a session rotates when its header timestamp falls in a different two-week bucket than now.
- `session-key.ts`: Owns the session-key grammar (`conversationId[":"suffix]`): derive/is-thread/conversation-id-of/thread-suffix-of. Nothing else may split on `:`; asserts the invariant that conversation ids never contain `:`.
- `store.ts`: Decides session file paths and ids — creation, the current-session pointer, thread session paths — and opens them through the harness `SessionStore`, which owns the header format and its version. Also resolves thread→main lineage: `resolveParentSessionForThread` picks the main session that was current at the thread's timestamp (stable across rotations) and records it as `parentSession` + `parentSessionId`, so Session View can walk the tree by id rather than by path.
- `types.ts`: The module's shared interfaces — session header, session-key options, resolved scopes, log records, and the `ChatHistorySync` option/report bags re-exported by the file that implements each.
