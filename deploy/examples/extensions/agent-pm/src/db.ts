/**
 * Storage for the agent-pm pipeline.
 *
 * Eight pipeline tables — `event_sources` and `events` in; `workflows`,
 * `workflow_versions` and `workflow_runs` deciding; `tasks` and `deliveries`
 * out; `feedback` closing the loop — plus the identity tables everything else
 * hangs off (`members`, `teams`, `team_members`, `holidays`).
 *
 * Deliberately absent: tables for daily check-ins and time off. Those are
 * Event kinds (`chat.checkin`, `calendar.event`), so they live in `events`
 * like everything else and are queried through the `(kind, occurred_at)`
 * index. Resisting a table per feature is most of what keeps this small: one
 * subject's whole timeline is then a single indexed scan rather than a union
 * across five tables.
 *
 * Type mapping: DateTime → TEXT holding an ISO 8601 instant with offset
 * (never a naive local string — every "today" question in this system is
 * asked in Asia/Taipei and answered by `clock.ts`, not by the database).
 * JSON → TEXT holding a JSON document. Duration → INTEGER seconds. Bool →
 * INTEGER 0/1.
 *
 * Columns that are "unique when set" (`tasks.dedupe_key`,
 * `deliveries.dedupe_key`, `feedback.source_ref`) default to NULL rather than
 * empty string: SQLite permits many NULLs in a unique index but only one ''.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/** Bumped whenever SCHEMA changes; `migrate` applies the gap. */
const SCHEMA_VERSION = 1;

const SCHEMA = `
-- ── identity ────────────────────────────────────────────────────────────────
-- Member is the hub: Slack id, GitHub login, and calendar/alias matching all
-- resolve to one row, so every downstream query joins on member_id alone.

CREATE TABLE IF NOT EXISTS members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    UNIQUE,
  slack_id      TEXT    UNIQUE,
  github_login  TEXT    UNIQUE,
  is_active     INTEGER NOT NULL DEFAULT 1,
  -- Free-text handles used to match calendar summaries and customer-channel
  -- senders back to a person. JSON list of strings.
  aliases       TEXT    NOT NULL DEFAULT '[]',
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_members_active ON members (is_active);

CREATE TABLE IF NOT EXISTS teams (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  slug               TEXT    NOT NULL UNIQUE,
  name               TEXT    NOT NULL,
  is_active          INTEGER NOT NULL DEFAULT 1,
  -- The single source of truth for "where does this team get notified".
  -- One column, on purpose. A hardcoded name map, a stored id, and a runtime
  -- channel lookup will all grow if allowed to, and then they disagree.
  slack_channel_id   TEXT,
  slack_channel_name TEXT,
  leader_member_id   INTEGER REFERENCES members (id) ON DELETE SET NULL,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id   INTEGER NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_member ON team_members (member_id);

-- Taiwan calendar. Gates every scheduled job that must not fire on a holiday,
-- and 'workday' rows are the compensatory Saturdays that must fire.
CREATE TABLE IF NOT EXISTS holidays (
  date TEXT    PRIMARY KEY,          -- YYYY-MM-DD, Asia/Taipei
  name TEXT    NOT NULL,
  kind TEXT    NOT NULL,             -- holiday | workday
  year INTEGER NOT NULL
);

-- ── pipeline: in ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS event_sources (
  key                  TEXT    PRIMARY KEY,   -- github | slack | gcal | clock | system
  kind                 TEXT    NOT NULL,      -- poll | push | clock | internal
  config               TEXT    NOT NULL DEFAULT '{}',
  cursor               TEXT,
  cursor_kind          TEXT    NOT NULL DEFAULT 'none',  -- timestamp | id | none
  -- Deliberate re-read window. Duplicates are absorbed by the idempotency key
  -- below; a silently skipped event is unrecoverable, so we trade the former.
  overlap_seconds      INTEGER NOT NULL DEFAULT 3600,
  is_enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at          TEXT,
  last_error           TEXT    NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

-- The universal inbox: append-only and immutable. Nothing updates a row here
-- except its state/state_reason as it is dispatched.
CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key       TEXT    NOT NULL REFERENCES event_sources (key),
  external_id      TEXT    NOT NULL,
  kind             TEXT    NOT NULL,          -- dotted: slack.standup, github.issue_opened, …
  subject          TEXT    NOT NULL DEFAULT '',
  actor            TEXT    NOT NULL DEFAULT '',
  actor_member_id  INTEGER REFERENCES members (id) ON DELETE SET NULL,
  -- Defaults to 'unknown', never a confident guess: alias matching only
  -- covers some teams, so a wrong-but-confident default is what makes
  -- classification drift invisible.
  actor_role       TEXT    NOT NULL DEFAULT 'unknown',
  title            TEXT    NOT NULL DEFAULT '',
  body             TEXT    NOT NULL DEFAULT '',
  payload          TEXT    NOT NULL DEFAULT '{}',
  attachments      TEXT    NOT NULL DEFAULT '[]',
  occurred_at      TEXT    NOT NULL,          -- source clock
  received_at      TEXT    NOT NULL,          -- our clock; not the same clock
  state            TEXT    NOT NULL DEFAULT 'pending',
                                              -- pending|dispatched|skipped|failed|logged
  state_reason     TEXT    NOT NULL DEFAULT '',
  caused_by_run_id INTEGER REFERENCES workflow_runs (id) ON DELETE SET NULL,
  UNIQUE (source_key, external_id)            -- the only idempotency key
);
CREATE INDEX IF NOT EXISTS idx_events_state    ON events (state, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_subject  ON events (subject, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_kind     ON events (kind, occurred_at);

-- ── pipeline: deciding ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workflows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key           TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL DEFAULT '',
  description   TEXT    NOT NULL DEFAULT '',
  -- Deterministic prefilter, e.g. {"kind":["slack.reply"],"subject_prefix":"task:"}.
  trigger       TEXT    NOT NULL DEFAULT '{}',
  prompt        TEXT    NOT NULL DEFAULT '',  -- blank for pure-code workflows
  tools         TEXT    NOT NULL DEFAULT '[]',
  output_schema TEXT    NOT NULL DEFAULT '{}',
  creates       TEXT    NOT NULL DEFAULT 'nothing',  -- task|event|delivery|nothing
  scope         TEXT    NOT NULL DEFAULT 'event',    -- event|sweep
  autonomy      TEXT    NOT NULL DEFAULT 'propose',  -- propose|approve|auto
  version       INTEGER NOT NULL DEFAULT 1,
  priority      INTEGER NOT NULL DEFAULT 100,
  model         TEXT    NOT NULL DEFAULT '',
  is_enabled    INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

-- The prompt as it was when it ran. Without this the version integer on a run
-- is meaningless: comparing v3's error rate to v2's needs the text.
CREATE TABLE IF NOT EXISTS workflow_versions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id         INTEGER NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  prompt              TEXT    NOT NULL,
  tools               TEXT    NOT NULL DEFAULT '[]',
  source              TEXT    NOT NULL DEFAULT 'manual',  -- manual|feedback_proposal
  proposal_task_id    INTEGER,
  feedback_from       TEXT    NOT NULL DEFAULT '[]',
  created_by_member_id INTEGER REFERENCES members (id) ON DELETE SET NULL,
  created_at          TEXT    NOT NULL,
  UNIQUE (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id            INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  workflow_id         INTEGER NOT NULL REFERENCES workflows (id) ON DELETE CASCADE,
  workflow_version_id INTEGER REFERENCES workflow_versions (id) ON DELETE SET NULL,
  attempt             INTEGER NOT NULL DEFAULT 1,
  feedback_injected   TEXT    NOT NULL DEFAULT '[]',
  status              TEXT    NOT NULL,       -- matched|skipped|running|succeeded|failed
  decided_by          TEXT    NOT NULL DEFAULT 'trigger',  -- trigger|llm|manual
  decision_reason     TEXT    NOT NULL DEFAULT '',
  output              TEXT    NOT NULL DEFAULT '{}',
  tool_calls          TEXT    NOT NULL DEFAULT '[]',
  model               TEXT    NOT NULL DEFAULT '',
  tokens_in           INTEGER NOT NULL DEFAULT 0,
  tokens_out          INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL    NOT NULL DEFAULT 0,
  error               TEXT    NOT NULL DEFAULT '',
  started_at          TEXT,
  finished_at         TEXT,
  UNIQUE (event_id, workflow_id, attempt)
);
CREATE INDEX IF NOT EXISTS idx_runs_status   ON workflow_runs (status, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs (workflow_id, status);

-- ── pipeline: out ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  queue                  TEXT    NOT NULL DEFAULT '',
  subject                TEXT    NOT NULL DEFAULT '',
  origin_run_id          INTEGER REFERENCES workflow_runs (id) ON DELETE SET NULL,
  kind                   TEXT    NOT NULL DEFAULT 'review',
  title                  TEXT    NOT NULL,
  title_en               TEXT    NOT NULL DEFAULT '',
  body                   TEXT    NOT NULL DEFAULT '',
  proposed_action        TEXT    NOT NULL DEFAULT '',
  proposed_payload       TEXT    NOT NULL DEFAULT '{}',
  assignee_member_id     INTEGER REFERENCES members (id) ON DELETE SET NULL,
  team_id                INTEGER REFERENCES teams (id) ON DELETE SET NULL,
  assigned_at            TEXT,
  assigned_by            TEXT    NOT NULL DEFAULT '',  -- owner|rule|llm|manual
  assigned_reason        TEXT    NOT NULL DEFAULT '',
  priority               TEXT    NOT NULL DEFAULT 'normal',
  -- status is lifecycle, approval is permission. One ten-state machine would
  -- conflate them: a drafted reply is open+pending, a review is open+not_required.
  status                 TEXT    NOT NULL DEFAULT 'open',
                                                  -- open|in_progress|blocked|done|dropped
  approval               TEXT    NOT NULL DEFAULT 'not_required',
                                                  -- not_required|pending|approved|rejected
  progress_note          TEXT    NOT NULL DEFAULT '',
  last_progress_at       TEXT,
  outcome                TEXT    NOT NULL DEFAULT '',
                                    -- resolved|no_action_needed|invalid|superseded
  due_at                 TEXT,
  nudge_interval_seconds INTEGER,
  last_nudged_at         TEXT,
  opened_at              TEXT    NOT NULL,
  first_notified_at      TEXT,               -- drives the 🆕 flag in digests
  first_response_at      TEXT,
  resolved_at            TEXT,
  resolved_by_member_id  INTEGER REFERENCES members (id) ON DELETE SET NULL,
  -- A database constraint, not a convention: exact-title dedup let any LLM
  -- rewording of one underlying problem create a second card.
  dedupe_key             TEXT    UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks (assignee_member_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due      ON tasks (status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_subject  ON tasks (subject, status);
CREATE INDEX IF NOT EXISTS idx_tasks_approval ON tasks (approval, status);
CREATE INDEX IF NOT EXISTS idx_tasks_queue    ON tasks (queue, status);

-- The single outbound log. Inbound is one table, outbound is one table.
CREATE TABLE IF NOT EXISTS deliveries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER REFERENCES tasks (id) ON DELETE SET NULL,
  run_id       INTEGER REFERENCES workflow_runs (id) ON DELETE SET NULL,
  target       TEXT    NOT NULL,   -- slack.post | slack.thread | slack.dm | github.comment
  address      TEXT    NOT NULL DEFAULT '{}',
  dedupe_key   TEXT    UNIQUE,     -- task:1042:assignment, digest:2026-07-30:C0123
  request      TEXT    NOT NULL DEFAULT '{}',
  response     TEXT    NOT NULL DEFAULT '{}',
  status       TEXT    NOT NULL DEFAULT 'pending',  -- pending|sent|failed
  -- The Slack ts a human replies under; this is what ties a thread reply back
  -- to the task that caused it.
  external_ref TEXT    NOT NULL DEFAULT '',
  error        TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL,
  sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_task ON deliveries (task_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_ref  ON deliveries (external_ref);

-- ── pipeline: the loop ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feedback (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id              INTEGER REFERENCES tasks (id) ON DELETE CASCADE,
  run_id               INTEGER REFERENCES workflow_runs (id) ON DELETE SET NULL,
  -- Denormalized from run so prompt injection is one indexed read.
  workflow_id          INTEGER REFERENCES workflows (id) ON DELETE CASCADE,
  -- The whole point: which decision was wrong, because each dimension maps to
  -- exactly one thing to change. A single thumbs-down teaches nothing.
  dimension            TEXT    NOT NULL,
                       -- existence|routing|assignment|priority|content|timing
  verdict              TEXT    NOT NULL,     -- good|needs_edit|wrong
  corrected_value      TEXT    NOT NULL DEFAULT '',
  note                 TEXT    NOT NULL DEFAULT '',
  author_member_id     INTEGER REFERENCES members (id) ON DELETE SET NULL,
  capture              TEXT    NOT NULL DEFAULT 'implicit',  -- implicit|reply|admin
  source_ref           TEXT    UNIQUE,       -- channel:ts — dedups reply-derived rows
  applied_to_version_id INTEGER REFERENCES workflow_versions (id) ON DELETE SET NULL,
  created_at           TEXT    NOT NULL,
  CHECK (task_id IS NOT NULL OR run_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_feedback_workflow  ON feedback (workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_dimension ON feedback (dimension, verdict);
`;

/**
 * Open the pipeline database, applying pragmas and schema.
 *
 * WAL plus a busy timeout is carried over deliberately: several schedules can
 * fire in the same minute, and overlapping writers on a single-file database
 * need exactly this not to fail each other with "database is locked".
 */
export function openDb(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(join(dataDir, "agent-pm.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * Apply the schema and record the version. Every statement is
 * `CREATE … IF NOT EXISTS`, so applying it to an up-to-date database is a
 * no-op; `user_version` exists so a future migration knows where it starts.
 */
function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current === SCHEMA_VERSION) return;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `agent-pm database is at schema version ${current}, newer than this build (${SCHEMA_VERSION})`,
    );
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

// ── row types ────────────────────────────────────────────────────────────────
// JSON and duration columns are named for what they hold on disk (`…Json`,
// `…Seconds`); callers parse at the edge rather than passing half-typed rows
// around.

export interface MemberRow {
  id: number;
  name: string;
  email: string | null;
  slack_id: string | null;
  github_login: string | null;
  is_active: number;
  aliases: string;
  created_at: string;
  updated_at: string;
}

export interface TeamRow {
  id: number;
  slug: string;
  name: string;
  is_active: number;
  slack_channel_id: string | null;
  slack_channel_name: string | null;
  leader_member_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface HolidayRow {
  date: string;
  name: string;
  kind: "holiday" | "workday";
  year: number;
}

export type EventState = "pending" | "dispatched" | "skipped" | "failed" | "logged";

export interface EventSourceRow {
  key: string;
  kind: "poll" | "push" | "clock" | "internal";
  config: string;
  cursor: string | null;
  cursor_kind: "timestamp" | "id" | "none";
  overlap_seconds: number;
  is_enabled: number;
  last_run_at: string | null;
  last_error: string;
  consecutive_failures: number;
}

export interface EventRow {
  id: number;
  source_key: string;
  external_id: string;
  kind: string;
  subject: string;
  actor: string;
  actor_member_id: number | null;
  actor_role: "internal" | "external" | "system" | "unknown";
  title: string;
  body: string;
  payload: string;
  attachments: string;
  occurred_at: string;
  received_at: string;
  state: EventState;
  state_reason: string;
  caused_by_run_id: number | null;
}

export interface WorkflowRow {
  id: number;
  key: string;
  name: string;
  description: string;
  trigger: string;
  prompt: string;
  tools: string;
  output_schema: string;
  creates: "task" | "event" | "delivery" | "nothing";
  scope: "event" | "sweep";
  autonomy: "propose" | "approve" | "auto";
  version: number;
  priority: number;
  model: string;
  is_enabled: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowVersionRow {
  id: number;
  workflow_id: number;
  version: number;
  prompt: string;
  tools: string;
  source: "manual" | "feedback_proposal";
  proposal_task_id: number | null;
  feedback_from: string;
  created_by_member_id: number | null;
  created_at: string;
}

export type WorkflowRunStatus = "matched" | "skipped" | "running" | "succeeded" | "failed";

export interface WorkflowRunRow {
  id: number;
  event_id: number;
  workflow_id: number;
  workflow_version_id: number | null;
  attempt: number;
  feedback_injected: string;
  status: WorkflowRunStatus;
  decided_by: "trigger" | "llm" | "manual";
  decision_reason: string;
  output: string;
  tool_calls: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  error: string;
  started_at: string | null;
  finished_at: string | null;
}

export type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "dropped";
export type TaskApproval = "not_required" | "pending" | "approved" | "rejected";
export type TaskOutcome = "" | "resolved" | "no_action_needed" | "invalid" | "superseded";

export interface TaskRow {
  id: number;
  queue: string;
  subject: string;
  origin_run_id: number | null;
  kind: string;
  title: string;
  title_en: string;
  body: string;
  proposed_action: string;
  proposed_payload: string;
  assignee_member_id: number | null;
  team_id: number | null;
  assigned_at: string | null;
  assigned_by: string;
  assigned_reason: string;
  priority: "urgent" | "high" | "normal" | "low";
  status: TaskStatus;
  approval: TaskApproval;
  progress_note: string;
  last_progress_at: string | null;
  outcome: TaskOutcome;
  due_at: string | null;
  nudge_interval_seconds: number | null;
  last_nudged_at: string | null;
  opened_at: string;
  first_notified_at: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  resolved_by_member_id: number | null;
  dedupe_key: string | null;
}

export interface DeliveryRow {
  id: number;
  task_id: number | null;
  run_id: number | null;
  target: string;
  address: string;
  dedupe_key: string | null;
  request: string;
  response: string;
  status: "pending" | "sent" | "failed";
  external_ref: string;
  error: string;
  created_at: string;
  sent_at: string | null;
}

export type FeedbackDimension =
  | "existence"
  | "routing"
  | "assignment"
  | "priority"
  | "content"
  | "timing";

export interface FeedbackRow {
  id: number;
  task_id: number | null;
  run_id: number | null;
  workflow_id: number | null;
  dimension: FeedbackDimension;
  verdict: "good" | "needs_edit" | "wrong";
  corrected_value: string;
  note: string;
  author_member_id: number | null;
  capture: "implicit" | "reply" | "admin";
  source_ref: string | null;
  applied_to_version_id: number | null;
  created_at: string;
}
