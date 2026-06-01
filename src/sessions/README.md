# src/sessions

This directory manages synchronization between chat history and Pi session files, plus session policy and metadata.

## Files

- `chat-session-manager.ts`: Synchronizes platform `log.jsonl` into Pi sessions and handles channel/thread bootstrap, rebuild, reset, and scope resolution.
- `metadata.ts`: Defines mikan session header metadata and detects sessions derived from platform history.
- `policy.ts`: Derives chat session keys from platform, conversation kind, threads, and root messages.
- `store.ts`: Manages session file creation, current pointers, thread session paths, and `SessionManager` patching.
