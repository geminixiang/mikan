# src/sessions

This directory manages synchronization between chat history and Pi session files, plus session policy and metadata.

## Files

- `chat-history-sync.ts`: `ChatHistorySync` — synchronizes platform `log.jsonl` into Pi sessions and handles channel/thread bootstrap, rebuild, reset, and scope resolution.
- `history-line.ts`: Owns the prompt history-line grammar (`[timestamp] [user] [in-thread:ts]: text`) — both the writer (agent prompts, history replay) and the parser (resume dedupe stripping). Round-trip tested so the two directions cannot drift apart silently.
- `metadata.ts`: Defines mikan session header metadata and detects sessions derived from platform history.
- `policy.ts`: Derives chat session keys from platform, conversation kind, threads, and root messages.
- `session-key.ts`: Owns the session-key grammar (`conversationId[":"suffix]`): derive/is-thread/conversation-id-of/thread-suffix-of. Nothing else may split on `:`; asserts the invariant that conversation ids never contain `:`.
- `store.ts`: Manages session file creation, current pointers, thread session paths, and `SessionManager` patching.
