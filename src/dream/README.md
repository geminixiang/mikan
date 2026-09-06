# src/dream

This module is the authority for scheduled Conversation-office Dream maintenance.

## Contract

- `DreamScheduler` checks registered offices every ten minutes during Taiwan time 02:00–05:00. It permits only one office sweep at a time; graceful shutdown drains the currently active office and does not begin another.
- `prepareOfficeDream` runs inside the runtime's office maintenance barrier. It reads every regular session JSONL file in the office, compares each stable session UUID with the host-private checkpoint, and returns a bounded batch of entries after each session's `throughEntryId`. Byte-identical files with the same session UUID are counted once; differing files with the same UUID fail closed. Oversized individual entries use an explicitly marked bounded head/tail representation. Backlogs advance over subsequent eligible sweeps instead of creating an unbounded model prompt.
- A plan is returned only when there is new evidence and the newest settled session entry in the office is at least five hours old. A `null` plan means the caller must not invoke the model.
- `generateMemoryAnchor` uses an in-memory harness session. It has a 120-second absolute hard timeout: on expiry it aborts the session, which propagates its abort signal to the provider, and the caller rejects without returning a Memory anchor. Dream prompts and responses, including late completion after an abort, never become new office session evidence or write office files.
- `commitOfficeDream` atomically replaces the office `MEMORY.md` first, then atomically advances `<office.stateDir>/dream.json`. If memory generation or writing fails, the checkpoint does not advance.

`dream.json` has version 1 and contains only per-session `throughEntryId` checkpoints. It is host-private State-dir data, not part of any Workspace projection.

`/new` and automatic session rotation create Clean sessions independently and never invoke Dream.
