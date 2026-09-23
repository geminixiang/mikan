---
status: accepted
---

# Long-lived top-level sessions replace biweekly rotation

Shared top-level channel sessions no longer rotate on a biweekly clock. A top-level session stays current until `/new` replaces it, and Pi's automatic compaction keeps the model context inside the window. Carrying knowledge across that boundary is a memory concern, not something a session clock should force.

## Context

Rotation started a Clean session with no platform history (`messageCount: 0`), so continuity after a boundary depended entirely on `MEMORY.md`. The Memory anchor is produced by Dream, which runs nightly, only after five idle hours, and in bounded batches. The two mechanisms were never synchronized: rotation did not wait for Dream, and Dream did not know which session was about to be cut.

Production evidence (clanker-002, 2026-09-05 to 2026-09-22, 185 offices):

- 21 rotations happened. For 16 of them the replaced session was still not fully read by Dream at the end of the period; 13 had never been read at all.
- 82.9% of all session entries had not been read by Dream. Among 50 offices active in the last week, only 9 were within a day of their latest evidence; the median age of the newest evidence Dream had read was 27 days.
- Dream visits session files in filename order, so thread sessions (`<slack-ts>.jsonl`) are processed before top-level sessions (`<iso-date>_<id>.jsonl`), leaving the rotating sessions last.
- Auto-compaction logged 204 starts, 174 completions, and 1 abort over the same deployment history. DM top-level sessions were never rotated and have run for months (up to 40 MB and about 20,000 entries) on compaction alone.

## Considered Options

- **Remove time-based rotation (chosen)** — compaction already bounds context, DM sessions show long-lived sessions work in production, and no user-visible context loss happens at an arbitrary calendar boundary.
- **Rotate only after Dream has consumed the session** — couples a request path to a nightly batch that is weeks behind; rotations would effectively never happen, or would block on maintenance.
- **Rotate but seed the new session from the latest compaction summary and recent messages** — preserves continuity, but adds a second summarization path next to Pi's compaction for a benefit (smaller files) that has not been shown to matter.

## Consequences

- `/new` is the only way to start a Clean top-level session. Existing sessions keep their files; no data migration is needed.
- Top-level session files grow without a time bound. Pi's append-only JSONL and compaction handle this today; if file size or materialization time becomes a measured problem, rotation should be reintroduced at a compaction boundary with the compaction summary carried forward, not on a calendar.
- Dream is unchanged by this decision. Moving durable-knowledge capture closer to when work happens (run settlement and compaction) is a separate decision.
