---
status: accepted
---

# Run conversations on pi-durable

Pi 1.0 removed the experimental harness from `@earendil-works/pi-agent-core`: `AgentHarness`, lanes, session repositories, compaction, execution environments, and the coding tools. The package keeps only `Agent` and its loop. Durable sessions moved to the new `@earendil-works/pi-durable`, which is a different design, not the old API under a new name. mikan relied on Pi to persist each turn, compact, retry, and recover an interrupted run, so staying on Pi means choosing where those guarantees now come from.

## Decision

1. **Conversations run on the pi-durable `Harness`.** Pi keeps owning persistence, the generation and tool loop, retry, compaction, and recovery. mikan does not rebuild them on the core `Agent`.
2. **One durable storage per session, in a directory.** A session that was one v4 JSONL file becomes a one-line JSON header file of the same name, with no format version of its own, beside an `openNodeJsonlStorage` directory, `<session>.durable`, and the session's thread runs as the storage's root conversation. Sessions keep their names, office ownership, and State dir location (ADR 0016); the header carries the session ID, creation time, and parent session ID, so listing sessions and resolving lineage do not open storage. SQLite storage stays a separate decision.
3. **mikan tools become durable tool registrations.** Each tool is adapted at one seam to `execute(args, api, context)`; the authorized executor, office, and run context are bound per run in closures, as before. The sandbox coding tools come from `@earendil-works/pi-durable/tools`, running on mikan's sandbox execution environment.
4. **Tools are `replay: "unsafe"` unless proven otherwise.** After a crash, an interrupted call returns an `interrupted` error to the model instead of running again; side effects are never repeated.
5. **`mikan migrate` imports v4 sessions once.** It reads each v4 main branch, writes its visible model context (the newest compaction summary and what follows) and every mikan bookkeeping entry into a new durable storage, closes unanswered tool calls with an error result, and moves the original file unchanged to the office's `sessions-v4/` directory in the State dir. Runs that were in flight at upgrade are not resumed.
6. **A run left unfinished by a previous process is aborted before the next prompt.** `resume()` continues it explicitly; nothing reruns it implicitly.

## Considered Options

- **Core `Agent` plus a mikan session journal**: keeps the smallest dependency, but moves persistence, compaction, and crash recovery into mikan, which then maintains a second durable framework next to Pi's.
- **Pin Pi 0.99**: no migration, but every later Pi fix and provider update is lost, and the removed harness gets no maintenance.
- **One durable storage per office with a conversation per thread**: closer to pi-durable's model, but changes how sessions are named, found, and forked in every adapter at once.
- **pi-coding-agent SDK**: brings a CLI-oriented session format and policy that mikan does not want.

## Consequences

- pi-durable is marked experimental; its API may change between releases, so the dependency is pinned and upgraded deliberately.
- The session format changes. The v4 reader lives only in the migration; the daemon refuses unmigrated sessions like any other pending migration (ADR 0014).
- An imported session shows only its visible context, not entries that an older compaction already hid; the original v4 file stays available for inspection.
- Tool progress, retries, and compactions reach mikan's presenter through pi-durable's agent events instead of harness events.
