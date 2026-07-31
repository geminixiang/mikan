/**
 * Row operations — the one place pipeline rows are written.
 *
 * `db.ts` owns the schema and the row shapes; this owns what may happen to
 * them. Keeping writes here is what makes the invariants checkable in one
 * place: an Event is never updated except its state, a Task is assigned at
 * most once, and idempotency is a database constraint rather than a
 * convention each caller re-implements.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./clock.js";
import type { EventRow, EventSourceRow, EventState, MemberRow, TeamRow } from "./db.js";

// ── event sources ────────────────────────────────────────────────────────────

/** Register a source if absent; existing rows (cursor, health) are untouched. */
export function ensureSource(
  db: DatabaseSync,
  source: Pick<EventSourceRow, "key" | "kind"> & Partial<EventSourceRow>,
): void {
  db.prepare(
    `INSERT INTO event_sources (key, kind, config, cursor, cursor_kind, overlap_seconds, is_enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO NOTHING`,
  ).run(
    source.key,
    source.kind,
    source.config ?? "{}",
    source.cursor ?? null,
    source.cursor_kind ?? "none",
    source.overlap_seconds ?? 3600,
    source.is_enabled ?? 1,
  );
}

export function getSource(db: DatabaseSync, key: string): EventSourceRow | undefined {
  return db.prepare("SELECT * FROM event_sources WHERE key = ?").get(key) as
    | EventSourceRow
    | undefined;
}

export function enabledSources(db: DatabaseSync): EventSourceRow[] {
  return db
    .prepare("SELECT * FROM event_sources WHERE is_enabled = 1 ORDER BY key")
    .all() as EventSourceRow[];
}

/** Record a successful run: advance the cursor and clear the failure streak. */
export function markSourceSuccess(db: DatabaseSync, key: string, cursor?: string): void {
  db.prepare(
    `UPDATE event_sources
        SET cursor = COALESCE(?, cursor), last_run_at = ?, last_error = '', consecutive_failures = 0
      WHERE key = ?`,
  ).run(cursor ?? null, nowIso(), key);
}

/**
 * Record a failed run. The cursor is deliberately not advanced — re-reading
 * is cheap and absorbed by the idempotency key, while skipping past a failure
 * loses events permanently.
 */
export function markSourceFailure(db: DatabaseSync, key: string, error: string): void {
  db.prepare(
    `UPDATE event_sources
        SET last_run_at = ?, last_error = ?, consecutive_failures = consecutive_failures + 1
      WHERE key = ?`,
  ).run(nowIso(), error.slice(0, 2000), key);
}

// ── events ───────────────────────────────────────────────────────────────────

export interface NewEvent {
  sourceKey: string;
  /** The source's own id. `(sourceKey, externalId)` is the idempotency key. */
  externalId: string;
  kind: string;
  subject?: string;
  actor?: string;
  actorMemberId?: number | null;
  actorRole?: EventRow["actor_role"];
  title?: string;
  body?: string;
  payload?: unknown;
  attachments?: unknown[];
  /** Source clock. Defaults to now, but a source that knows better should say. */
  occurredAt?: string;
  /**
   * `logged` records something without offering it for dispatch — task state
   * transitions, which are history rather than work. Without the distinction
   * the "matched no workflow" report drowns in benign internal churn.
   */
  state?: Extract<EventState, "pending" | "logged">;
  causedByRunId?: number | null;
}

/**
 * Insert an event, ignoring a repeat of one already seen.
 *
 * Returns the row id when this call created it, and undefined when the
 * `(source, external_id)` pair was already present. Sources deliberately
 * re-read an overlap window every run, so the duplicate path is the common
 * one, not an error.
 */
export function insertEvent(db: DatabaseSync, event: NewEvent): number | undefined {
  const now = nowIso();
  const { changes, lastInsertRowid } = db
    .prepare(
      `INSERT INTO events (
         source_key, external_id, kind, subject, actor, actor_member_id, actor_role,
         title, body, payload, attachments, occurred_at, received_at, state, caused_by_run_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_key, external_id) DO NOTHING`,
    )
    .run(
      event.sourceKey,
      event.externalId,
      event.kind,
      event.subject ?? "",
      event.actor ?? "",
      event.actorMemberId ?? null,
      event.actorRole ?? "unknown",
      event.title ?? "",
      event.body ?? "",
      JSON.stringify(event.payload ?? {}),
      JSON.stringify(event.attachments ?? []),
      event.occurredAt ?? now,
      now,
      event.state ?? "pending",
      event.causedByRunId ?? null,
    );
  return changes > 0 ? Number(lastInsertRowid) : undefined;
}

/** Pending events oldest-first — the work queue for `run_workflows`. */
export function pendingEvents(db: DatabaseSync, limit = 200): EventRow[] {
  return db
    .prepare(`SELECT * FROM events WHERE state = 'pending' ORDER BY occurred_at, id LIMIT ?`)
    .all(limit) as EventRow[];
}

/** Move an event out of the pending queue. Events are otherwise immutable. */
export function setEventState(
  db: DatabaseSync,
  eventId: number,
  state: EventState,
  reason = "",
): void {
  db.prepare("UPDATE events SET state = ?, state_reason = ? WHERE id = ?").run(
    state,
    reason.slice(0, 2000),
    eventId,
  );
}

/** A subject's timeline — messages, activity, and task transitions in one scan. */
export function eventsForSubject(db: DatabaseSync, subject: string, limit = 200): EventRow[] {
  return db
    .prepare("SELECT * FROM events WHERE subject = ? ORDER BY occurred_at DESC, id DESC LIMIT ?")
    .all(subject, limit) as EventRow[];
}

// ── identity ─────────────────────────────────────────────────────────────────

export function activeMembers(db: DatabaseSync): MemberRow[] {
  return db.prepare("SELECT * FROM members WHERE is_active = 1 ORDER BY name").all() as MemberRow[];
}

export function memberBySlackId(db: DatabaseSync, slackId: string): MemberRow | undefined {
  return db.prepare("SELECT * FROM members WHERE slack_id = ?").get(slackId) as
    | MemberRow
    | undefined;
}

export function activeTeams(db: DatabaseSync): TeamRow[] {
  return db.prepare("SELECT * FROM teams WHERE is_active = 1 ORDER BY slug").all() as TeamRow[];
}

/**
 * The channel a member's notifications go to: their alphabetically-first
 * active team that has one. Arbitrary, but deterministic — and once people
 * are used to a digest arriving in one place, changing the rule silently
 * moves it somewhere they are not looking.
 */
export function digestChannelFor(db: DatabaseSync, memberId: number): TeamRow | undefined {
  return db
    .prepare(
      `SELECT teams.* FROM teams
         JOIN team_members ON team_members.team_id = teams.id
        WHERE team_members.member_id = ?
          AND teams.is_active = 1
          AND teams.slack_channel_id IS NOT NULL
        ORDER BY teams.name
        LIMIT 1`,
    )
    .get(memberId) as TeamRow | undefined;
}
