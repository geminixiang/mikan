import { chmodSync, existsSync, lstatSync, statSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type {
  AgentAuditEventDetails,
  AgentAuditEventEnvelope,
  AgentAuditEventRecord,
  AgentAuditEventType,
  AgentAuditModelRequestSummary,
  AgentAuditRunDetail,
  AgentAuditRunDetailQuery,
  AgentAuditRunKind,
  AgentAuditRunPage,
  AgentAuditRunQuery,
  AgentAuditRunSummary,
  AgentAuditStatus,
  AgentAuditToolCallSummary,
  AgentAuditUsage,
  AuditDetailSchema,
  AuditWorkerHealth,
  AuditWorkerInitData,
  AuditWorkerRequest,
  AuditWorkerResponse,
} from "./types.js";

const AGENT_AUDIT_SCHEMA_VERSION = 1;

const AGENT_AUDIT_SCHEMA_SQL = `
  CREATE TABLE audit_runs (
    run_id TEXT PRIMARY KEY,
    run_kind TEXT NOT NULL,
    office_key TEXT NOT NULL,
    platform TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    session_id TEXT,
    parent_run_id TEXT,
    parent_tool_call_id TEXT,
    status TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    duration_ms INTEGER,
    model_provider TEXT,
    model_id TEXT,
    stop_reason TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    llm_calls INTEGER NOT NULL DEFAULT 0,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    last_event_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  );

  CREATE TABLE audit_events (
    event_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    occurred_at_ms INTEGER NOT NULL,
    ingested_at_ms INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    run_sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    status TEXT,
    session_id TEXT,
    turn_id TEXT,
    model_request_id TEXT,
    tool_call_id TEXT,
    related_run_id TEXT,
    tool_name TEXT,
    model_provider TEXT,
    model_id TEXT,
    response_id TEXT,
    stop_reason TEXT,
    error_type TEXT,
    duration_ms INTEGER,
    llm_calls INTEGER,
    tool_calls INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    total_tokens INTEGER,
    cost_usd REAL,
    details_json TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    UNIQUE(run_id, run_sequence)
  );

  CREATE TABLE audit_tool_calls (
    run_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    turn_id TEXT,
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    duration_ms INTEGER,
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY(run_id, tool_call_id)
  );

  CREATE TABLE audit_model_requests (
    run_id TEXT NOT NULL,
    model_request_id TEXT NOT NULL,
    turn_id TEXT,
    model_provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    response_id TEXT,
    status TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    duration_ms INTEGER,
    stop_reason TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    expires_at_ms INTEGER NOT NULL,
    PRIMARY KEY(run_id, model_request_id)
  );

  CREATE INDEX audit_runs_office_time
    ON audit_runs(office_key, started_at_ms DESC, run_id DESC);
  CREATE INDEX audit_runs_platform_conversation_time
    ON audit_runs(platform, conversation_id, started_at_ms DESC, run_id DESC);
  CREATE INDEX audit_runs_parent
    ON audit_runs(parent_run_id, started_at_ms, run_id);
  CREATE INDEX audit_runs_expiry ON audit_runs(expires_at_ms);
  CREATE INDEX audit_events_run_sequence ON audit_events(run_id, run_sequence);
  CREATE INDEX audit_events_tool_time
    ON audit_events(tool_name, occurred_at_ms DESC, event_id DESC)
    WHERE tool_name IS NOT NULL;
  CREATE INDEX audit_events_expiry ON audit_events(expires_at_ms);
  CREATE INDEX audit_tool_calls_name_time
    ON audit_tool_calls(tool_name, started_at_ms DESC, run_id DESC);
  CREATE INDEX audit_tool_calls_expiry ON audit_tool_calls(expires_at_ms);
  CREATE INDEX audit_model_requests_expiry ON audit_model_requests(expires_at_ms);
`;

const AGENT_AUDIT_STATEMENT_SQL = {
  insertEvent: `
    INSERT OR IGNORE INTO audit_events (
      event_id, schema_version, occurred_at_ms, ingested_at_ms, run_id, run_sequence,
      event_type, status, session_id, turn_id, model_request_id, tool_call_id,
      related_run_id, tool_name, model_provider, model_id, response_id, stop_reason,
      error_type, duration_ms, llm_calls, tool_calls, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, details_json,
      expires_at_ms
    ) VALUES (
      $eventId, $schemaVersion, $occurredAtMs, $ingestedAtMs, $runId, $runSequence,
      $eventType, $status, $sessionId, $turnId, $modelRequestId, $toolCallId,
      $relatedRunId, $toolName, $modelProvider, $modelId, $responseId, $stopReason,
      $errorType, $durationMs, $llmCalls, $toolCalls, $input, $output,
      $cacheRead, $cacheWrite, $totalTokens, $costUsd, $detailsJson, $expiresAtMs
    )
  `,
  ensureRun: `
    INSERT OR IGNORE INTO audit_runs (
      run_id, run_kind, office_key, platform, conversation_id, session_key, session_id,
      parent_run_id, parent_tool_call_id, status, started_at_ms, last_event_at_ms,
      expires_at_ms
    ) VALUES (
      $runId, $runKind, $officeKey, $platform, $conversationId, $sessionKey, $sessionId,
      $parentRunId, $parentToolCallId, $status, $occurredAtMs, $occurredAtMs,
      $expiresAtMs
    )
  `,
  touchRun: `
    UPDATE audit_runs SET
      session_id = COALESCE($sessionId, session_id),
      last_event_at_ms = MAX(last_event_at_ms, $occurredAtMs),
      expires_at_ms = MAX(expires_at_ms, $expiresAtMs)
    WHERE run_id = $runId
  `,
  startRun: `
    UPDATE audit_runs SET
      status = 'running',
      started_at_ms = $occurredAtMs,
      model_provider = COALESCE($modelProvider, model_provider),
      model_id = COALESCE($modelId, model_id)
    WHERE run_id = $runId AND ended_at_ms IS NULL
  `,
  finishRun: `
    UPDATE audit_runs SET
      status = $status,
      ended_at_ms = $occurredAtMs,
      duration_ms = $durationMs,
      model_provider = COALESCE($modelProvider, model_provider),
      model_id = COALESCE($modelId, model_id),
      stop_reason = $stopReason,
      input_tokens = COALESCE($input, input_tokens),
      output_tokens = COALESCE($output, output_tokens),
      cache_read_tokens = COALESCE($cacheRead, cache_read_tokens),
      cache_write_tokens = COALESCE($cacheWrite, cache_write_tokens),
      total_tokens = COALESCE($totalTokens, total_tokens),
      cost_usd = COALESCE($costUsd, cost_usd),
      llm_calls = COALESCE($llmCalls, llm_calls),
      tool_calls = COALESCE($toolCalls, tool_calls)
    WHERE run_id = $runId AND ended_at_ms IS NULL
  `,
  setRunModel: `
    UPDATE audit_runs SET model_provider = $modelProvider, model_id = $modelId
    WHERE run_id = $runId
  `,
  startTool: `
    INSERT INTO audit_tool_calls (
      run_id, tool_call_id, turn_id, tool_name, status, started_at_ms, expires_at_ms
    ) VALUES ($runId, $toolCallId, $turnId, $toolName, 'running', $occurredAtMs, $expiresAtMs)
    ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
      turn_id = COALESCE(excluded.turn_id, audit_tool_calls.turn_id),
      tool_name = excluded.tool_name,
      status = 'running',
      started_at_ms = MIN(audit_tool_calls.started_at_ms, excluded.started_at_ms),
      expires_at_ms = MAX(audit_tool_calls.expires_at_ms, excluded.expires_at_ms)
  `,
  finishTool: `
    INSERT INTO audit_tool_calls (
      run_id, tool_call_id, turn_id, tool_name, status, started_at_ms,
      ended_at_ms, duration_ms, expires_at_ms
    ) VALUES (
      $runId, $toolCallId, $turnId, $toolName, $status, $occurredAtMs,
      $occurredAtMs, $durationMs, $expiresAtMs
    )
    ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
      status = excluded.status,
      ended_at_ms = excluded.ended_at_ms,
      duration_ms = excluded.duration_ms,
      expires_at_ms = MAX(audit_tool_calls.expires_at_ms, excluded.expires_at_ms)
  `,
  startModelRequest: `
    INSERT INTO audit_model_requests (
      run_id, model_request_id, turn_id, model_provider, model_id, status,
      started_at_ms, expires_at_ms
    ) VALUES (
      $runId, $modelRequestId, $turnId, $modelProvider, $modelId, 'running',
      $occurredAtMs, $expiresAtMs
    )
    ON CONFLICT(run_id, model_request_id) DO UPDATE SET
      status = 'running',
      started_at_ms = MIN(audit_model_requests.started_at_ms, excluded.started_at_ms),
      expires_at_ms = MAX(audit_model_requests.expires_at_ms, excluded.expires_at_ms)
  `,
  finishModelRequest: `
    INSERT INTO audit_model_requests (
      run_id, model_request_id, turn_id, model_provider, model_id, response_id,
      status, started_at_ms, ended_at_ms, duration_ms, stop_reason,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      total_tokens, cost_usd, expires_at_ms
    ) VALUES (
      $runId, $modelRequestId, $turnId, $modelProvider, $modelId, $responseId,
      $status, $occurredAtMs, $occurredAtMs, $durationMs, $stopReason,
      COALESCE($input, 0), COALESCE($output, 0), COALESCE($cacheRead, 0),
      COALESCE($cacheWrite, 0), COALESCE($totalTokens, 0), COALESCE($costUsd, 0),
      $expiresAtMs
    )
    ON CONFLICT(run_id, model_request_id) DO UPDATE SET
      response_id = excluded.response_id,
      status = excluded.status,
      ended_at_ms = excluded.ended_at_ms,
      duration_ms = excluded.duration_ms,
      stop_reason = excluded.stop_reason,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd,
      expires_at_ms = MAX(audit_model_requests.expires_at_ms, excluded.expires_at_ms)
  `,
} as const;

const MAX_QUERY_LIMIT = 100;
const DEFAULT_EVENT_PAGE_LIMIT = 200;
const MAX_EVENT_PAGE_LIMIT = 500;
const RELATED_ROW_LIMIT = 500;
const RETENTION_RUN_BATCH_SIZE = 100;
const WAL_RETRY_ATTEMPTS = 100;
const WAL_RETRY_DELAY_MS = 20;
const WAL_RETRY_SIGNAL = new Int32Array(new SharedArrayBuffer(4));
const AUDIT_STATUSES = new Set<AgentAuditStatus>([
  "admitted",
  "running",
  "completed",
  "failed",
  "aborted",
  "blocked",
  "cancelled",
  "timeout",
  "budget_exceeded",
  "invalid_output",
]);
const AUDIT_RUN_KINDS = new Set<AgentAuditRunKind>([
  "interactive",
  "event",
  "session_dream",
  "subagent",
]);
const AUDIT_EVENT_TYPES = new Set<AgentAuditEventType>([
  "run_admitted",
  "run_started",
  "run_setup_failed",
  "run_completed",
  "run_failed",
  "run_aborted",
  "turn_started",
  "turn_completed",
  "model_request_started",
  "model_request_completed",
  "model_request_failed",
  "model_request_aborted",
  "tool_started",
  "tool_completed",
  "tool_failed",
  "tool_blocked",
  "retry_started",
  "retry_completed",
  "compaction_started",
  "compaction_completed",
  "compaction_failed",
  "budget_exceeded",
  "subagent_spawned",
  "subagent_completed",
]);

type SqlRow = Record<string, unknown>;

interface AuditStatements {
  insertEvent: StatementSync;
  ensureRun: StatementSync;
  touchRun: StatementSync;
  startRun: StatementSync;
  finishRun: StatementSync;
  setRunModel: StatementSync;
  startTool: StatementSync;
  finishTool: StatementSync;
  startModelRequest: StatementSync;
  finishModelRequest: StatementSync;
}

interface CursorValue {
  startedAtMs: number;
  runId: string;
}

interface CountRow {
  count: number;
}

const init = workerData as AuditWorkerInitData;
let db: DatabaseSync | undefined;
let statements: AuditStatements | undefined;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function post(response: AuditWorkerResponse): void {
  parentPort?.postMessage(response);
}

function secureDatabaseFiles(): void {
  for (const path of [init.dbPath, `${init.dbPath}-wal`, `${init.dbPath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

function assertDatabaseFilesAreRegular(): void {
  for (const path of [init.dbPath, `${init.dbPath}-wal`, `${init.dbPath}-shm`]) {
    if (!existsSync(path)) continue;
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Audit database path is not a regular file: ${path}`);
    }
  }
}

function migrate(database: DatabaseSync): void {
  database.exec("BEGIN EXCLUSIVE");
  try {
    const row = database.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    const version = row?.user_version ?? 0;
    if (version > AGENT_AUDIT_SCHEMA_VERSION) {
      throw new Error(
        `Audit database schema ${version} is newer than supported ${AGENT_AUDIT_SCHEMA_VERSION}`,
      );
    }
    if (version < AGENT_AUDIT_SCHEMA_VERSION) {
      database.exec(AGENT_AUDIT_SCHEMA_SQL);
      database.exec(`PRAGMA user_version = ${AGENT_AUDIT_SCHEMA_VERSION}`);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function isDatabaseBusy(error: unknown): boolean {
  return error instanceof Error && /(?:locked|busy)/i.test(error.message);
}

function enableWal(database: DatabaseSync): void {
  for (let attempt = 1; attempt <= WAL_RETRY_ATTEMPTS; attempt++) {
    try {
      const row = database.prepare("PRAGMA journal_mode = WAL").get() as
        | { journal_mode: string }
        | undefined;
      if (row?.journal_mode.toLowerCase() !== "wal") {
        throw new Error(`SQLite refused WAL mode: ${row?.journal_mode ?? "unknown"}`);
      }
      return;
    } catch (error) {
      if (!isDatabaseBusy(error) || attempt === WAL_RETRY_ATTEMPTS) throw error;
      Atomics.wait(WAL_RETRY_SIGNAL, 0, 0, WAL_RETRY_DELAY_MS);
    }
  }
}

function openDatabase(): DatabaseSync {
  assertDatabaseFilesAreRegular();
  const database = new DatabaseSync(init.dbPath);
  database.exec("PRAGMA busy_timeout = 30000");
  migrate(database);
  enableWal(database);
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
  secureDatabaseFiles();
  return database;
}

function prepareAuditStatements(database: DatabaseSync): AuditStatements {
  const prepared: AuditStatements = {
    insertEvent: database.prepare(AGENT_AUDIT_STATEMENT_SQL.insertEvent),
    ensureRun: database.prepare(AGENT_AUDIT_STATEMENT_SQL.ensureRun),
    touchRun: database.prepare(AGENT_AUDIT_STATEMENT_SQL.touchRun),
    startRun: database.prepare(AGENT_AUDIT_STATEMENT_SQL.startRun),
    finishRun: database.prepare(AGENT_AUDIT_STATEMENT_SQL.finishRun),
    setRunModel: database.prepare(AGENT_AUDIT_STATEMENT_SQL.setRunModel),
    startTool: database.prepare(AGENT_AUDIT_STATEMENT_SQL.startTool),
    finishTool: database.prepare(AGENT_AUDIT_STATEMENT_SQL.finishTool),
    startModelRequest: database.prepare(AGENT_AUDIT_STATEMENT_SQL.startModelRequest),
    finishModelRequest: database.prepare(AGENT_AUDIT_STATEMENT_SQL.finishModelRequest),
  };
  for (const statement of Object.values(prepared)) {
    statement.setAllowUnknownNamedParameters(true);
  }
  return prepared;
}

function eventParams(event: AgentAuditEventEnvelope): Record<string, SQLInputValue> {
  const usage = event.usage;
  return {
    $eventId: event.eventId,
    $schemaVersion: event.schemaVersion,
    $occurredAtMs: event.occurredAtMs,
    $ingestedAtMs: event.ingestedAtMs,
    $runId: event.runId,
    $runSequence: event.runSequence,
    $eventType: event.type,
    $runKind: event.runKind,
    $officeKey: event.officeKey,
    $platform: event.platform,
    $conversationId: event.conversationId,
    $sessionKey: event.sessionKey,
    $parentRunId: event.parentRunId ?? null,
    $parentToolCallId: event.parentToolCallId ?? null,
    $status: event.status ?? null,
    $sessionId: event.sessionId ?? null,
    $turnId: event.turnId ?? null,
    $modelRequestId: event.modelRequestId ?? null,
    $toolCallId: event.toolCallId ?? null,
    $relatedRunId: event.relatedRunId ?? null,
    $toolName: event.toolName ?? null,
    $modelProvider: event.modelProvider ?? null,
    $modelId: event.modelId ?? null,
    $responseId: event.responseId ?? null,
    $stopReason: event.stopReason ?? null,
    $errorType: event.errorType ?? null,
    $durationMs: event.durationMs ?? null,
    $llmCalls: event.llmCalls ?? null,
    $toolCalls: event.toolCalls ?? null,
    $input: usage?.input ?? null,
    $output: usage?.output ?? null,
    $cacheRead: usage?.cacheRead ?? null,
    $cacheWrite: usage?.cacheWrite ?? null,
    $totalTokens: usage?.totalTokens ?? null,
    $costUsd: usage?.costUsd ?? null,
    $detailsJson: JSON.stringify(event.details ?? {}),
    $expiresAtMs: event.expiresAtMs,
  };
}

function terminalStatus(event: AgentAuditEventEnvelope): AgentAuditStatus {
  if (event.status) return event.status;
  if (event.type === "run_aborted" || event.type === "model_request_aborted") return "aborted";
  if (event.type.endsWith("failed")) return "failed";
  return "completed";
}

function projectEvent(event: AgentAuditEventEnvelope, params: Record<string, SQLInputValue>): void {
  const prepared = statements!;
  prepared.ensureRun.run({ ...params, $status: event.status ?? "admitted" });
  prepared.touchRun.run(params);

  if (event.type === "run_started") prepared.startRun.run(params);
  if (
    event.type === "run_setup_failed" ||
    event.type === "run_completed" ||
    event.type === "run_failed" ||
    event.type === "run_aborted"
  ) {
    prepared.finishRun.run({ ...params, $status: terminalStatus(event) });
  }
  if (event.type === "model_request_started") {
    prepared.setRunModel.run(params);
    prepared.startModelRequest.run(params);
  }
  if (event.type.startsWith("model_request_") && event.type !== "model_request_started") {
    prepared.finishModelRequest.run({ ...params, $status: terminalStatus(event) });
  }
  if (event.type === "tool_started") prepared.startTool.run(params);
  if (
    event.type === "tool_completed" ||
    event.type === "tool_failed" ||
    event.type === "tool_blocked"
  ) {
    prepared.finishTool.run({ ...params, $status: terminalStatus(event) });
  }
}

function appendEvents(events: AgentAuditEventEnvelope[]): number {
  const database = db!;
  database.exec("BEGIN IMMEDIATE");
  let written = 0;
  try {
    for (const event of events) {
      const params = eventParams(event);
      const result = statements!.insertEvent.run(params);
      if (result.changes === 0) continue;
      projectEvent(event, params);
      written++;
    }
    database.exec("COMMIT");
    secureDatabaseFiles();
    return written;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function parseLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || (limit ?? 0) < 1) return 50;
  return Math.min(limit!, MAX_QUERY_LIMIT);
}

function decodeCursor(value: string | undefined): CursorValue | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.startedAtMs !== "number" || typeof record.runId !== "string") {
      return undefined;
    }
    return { startedAtMs: record.startedAtMs, runId: record.runId };
  } catch {
    return undefined;
  }
}

function encodeCursor(row: AgentAuditRunSummary): string {
  return Buffer.from(JSON.stringify({ startedAtMs: row.startedAtMs, runId: row.runId })).toString(
    "base64url",
  );
}

function addFilter(
  clauses: string[],
  params: Record<string, SQLInputValue>,
  clause: string,
  key: string,
  value: SQLInputValue | undefined,
): void {
  if (value === undefined || value === "") return;
  clauses.push(clause);
  params[key] = value;
}

function encodeOfficeScope(values: readonly string[] | undefined): string | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error("officeKeys must be an array");
  const keys = values.map((value) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw new Error("officeKeys contains an invalid office key");
    }
    return value;
  });
  return JSON.stringify([...new Set(keys)]);
}

function buildRunQuery(query: AgentAuditRunQuery): {
  sql: string;
  params: Record<string, SQLInputValue>;
  limit: number;
} {
  const clauses: string[] = [];
  const params: Record<string, SQLInputValue> = {};
  const officeScope = encodeOfficeScope(query.officeKeys);
  if (officeScope !== undefined) {
    clauses.push("r.office_key IN (SELECT value FROM json_each($officeKeys))");
    params.$officeKeys = officeScope;
  }
  addFilter(clauses, params, "r.office_key = $officeKey", "$officeKey", query.officeKey);
  addFilter(clauses, params, "r.platform = $platform", "$platform", query.platform);
  addFilter(
    clauses,
    params,
    "r.conversation_id = $conversationId",
    "$conversationId",
    query.conversationId,
  );
  addFilter(clauses, params, "r.run_id = $runId", "$runId", query.runId);
  addFilter(clauses, params, "r.status = $status", "$status", query.status);
  addFilter(clauses, params, "r.started_at_ms >= $fromMs", "$fromMs", query.fromMs);
  addFilter(clauses, params, "r.started_at_ms < $toMs", "$toMs", query.toMs);
  if (query.toolName) {
    clauses.push(
      "EXISTS (SELECT 1 FROM audit_tool_calls t WHERE t.run_id = r.run_id AND t.tool_name = $toolName)",
    );
    params.$toolName = query.toolName;
  }
  const cursor = decodeCursor(query.cursor);
  if (query.cursor && !cursor) throw new Error("Invalid audit cursor");
  if (cursor) {
    clauses.push(
      "(r.started_at_ms < $cursorTime OR (r.started_at_ms = $cursorTime AND r.run_id < $cursorRunId))",
    );
    params.$cursorTime = cursor.startedAtMs;
    params.$cursorRunId = cursor.runId;
  }
  const limit = parseLimit(query.limit);
  params.$limit = limit + 1;
  return {
    sql: `${runSelectSql()} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY r.started_at_ms DESC, r.run_id DESC LIMIT $limit`,
    params,
    limit,
  };
}

function runSelectSql(): string {
  return `SELECT
    r.run_id AS runId, r.run_kind AS runKind, r.office_key AS officeKey,
    r.platform, r.conversation_id AS conversationId, r.session_key AS sessionKey,
    r.session_id AS sessionId, r.parent_run_id AS parentRunId,
    r.parent_tool_call_id AS parentToolCallId, r.status,
    r.started_at_ms AS startedAtMs, r.ended_at_ms AS endedAtMs,
    r.duration_ms AS durationMs, r.model_provider AS modelProvider,
    r.model_id AS modelId, r.stop_reason AS stopReason,
    r.input_tokens AS input, r.output_tokens AS output,
    r.cache_read_tokens AS cacheRead, r.cache_write_tokens AS cacheWrite,
    r.total_tokens AS totalTokens, r.cost_usd AS costUsd,
    r.llm_calls AS llmCalls, r.tool_calls AS toolCalls,
    r.last_event_at_ms AS lastEventAtMs
    FROM audit_runs r`;
}

function invalidRow(field: string): never {
  throw new Error(`Invalid audit database row field: ${field}`);
}

function rowString(row: SqlRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) return invalidRow(field);
  return value;
}

function rowNullableString(row: SqlRow, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "string") return invalidRow(field);
  return value;
}

function rowNumber(row: SqlRow, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) return invalidRow(field);
  return value;
}

function rowNullableNumber(row: SqlRow, field: string): number | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return invalidRow(field);
  return value;
}

function rowEnum<T extends string>(row: SqlRow, field: string, values: ReadonlySet<T>): T {
  const value = rowString(row, field);
  if (!values.has(value as T)) return invalidRow(field);
  return value as T;
}

function rowNullableStatus(row: SqlRow): AgentAuditStatus | null {
  if (row.status === null) return null;
  return rowEnum(row, "status", AUDIT_STATUSES);
}

function mapRunRow(row: SqlRow): AgentAuditRunSummary {
  return {
    runId: rowString(row, "runId"),
    runKind: rowEnum(row, "runKind", AUDIT_RUN_KINDS),
    officeKey: rowString(row, "officeKey"),
    platform: rowString(row, "platform"),
    conversationId: rowString(row, "conversationId"),
    sessionKey: rowString(row, "sessionKey"),
    sessionId: rowNullableString(row, "sessionId"),
    parentRunId: rowNullableString(row, "parentRunId"),
    parentToolCallId: rowNullableString(row, "parentToolCallId"),
    status: rowEnum(row, "status", AUDIT_STATUSES),
    startedAtMs: rowNumber(row, "startedAtMs"),
    endedAtMs: rowNullableNumber(row, "endedAtMs"),
    durationMs: rowNullableNumber(row, "durationMs"),
    modelProvider: rowNullableString(row, "modelProvider"),
    modelId: rowNullableString(row, "modelId"),
    stopReason: rowNullableString(row, "stopReason"),
    input: rowNumber(row, "input"),
    output: rowNumber(row, "output"),
    cacheRead: rowNumber(row, "cacheRead"),
    cacheWrite: rowNumber(row, "cacheWrite"),
    totalTokens: rowNumber(row, "totalTokens"),
    costUsd: rowNumber(row, "costUsd"),
    llmCalls: rowNumber(row, "llmCalls"),
    toolCalls: rowNumber(row, "toolCalls"),
    lastEventAtMs: rowNumber(row, "lastEventAtMs"),
  };
}

function listRuns(query: AgentAuditRunQuery): AgentAuditRunPage {
  const built = buildRunQuery(query);
  const rows = (db!.prepare(built.sql).all(built.params) as unknown as SqlRow[]).map(mapRunRow);
  const hasMore = rows.length > built.limit;
  if (hasMore) rows.pop();
  const last = rows.at(-1);
  return {
    runs: rows,
    ...(hasMore && last ? { nextCursor: encodeCursor(last) } : {}),
  };
}

function eventUsage(row: SqlRow): AgentAuditUsage | null {
  const totalTokens = rowNullableNumber(row, "totalTokens");
  if (totalTokens === null) return null;
  return {
    input: rowNumber(row, "input"),
    output: rowNumber(row, "output"),
    cacheRead: rowNumber(row, "cacheRead"),
    cacheWrite: rowNumber(row, "cacheWrite"),
    totalTokens,
    costUsd: rowNumber(row, "costUsd"),
  };
}

function normalizeDecodedDetails(
  value: unknown,
  schema: AuditDetailSchema,
): AgentAuditEventDetails {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, values] of Object.entries(schema.enumValues)) {
    const candidate = source[key];
    if (typeof candidate === "string" && values.includes(candidate)) normalized[key] = candidate;
  }
  for (const [key, limit] of Object.entries(schema.stringLimits)) {
    const candidate = source[key];
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) normalized[key] = trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
  }
  for (const key of schema.numberKeys) {
    const candidate = source[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
      normalized[key] = candidate;
    }
  }
  for (const key of schema.booleanKeys) {
    if (typeof source[key] === "boolean") normalized[key] = source[key];
  }
  return normalized as AgentAuditEventDetails;
}

function parseEventDetails(value: unknown): AgentAuditEventDetails {
  try {
    return normalizeDecodedDetails(JSON.parse(String(value ?? "{}")) as unknown, init.detailSchema);
  } catch {
    return {};
  }
}

function mapEventRow(row: SqlRow): AgentAuditEventRecord {
  return {
    eventId: rowString(row, "eventId"),
    occurredAtMs: rowNumber(row, "occurredAtMs"),
    ingestedAtMs: rowNumber(row, "ingestedAtMs"),
    runSequence: rowNumber(row, "runSequence"),
    runId: rowString(row, "runId"),
    eventType: rowEnum(row, "eventType", AUDIT_EVENT_TYPES),
    status: rowNullableStatus(row),
    sessionId: rowNullableString(row, "sessionId"),
    turnId: rowNullableString(row, "turnId"),
    modelRequestId: rowNullableString(row, "modelRequestId"),
    toolCallId: rowNullableString(row, "toolCallId"),
    relatedRunId: rowNullableString(row, "relatedRunId"),
    toolName: rowNullableString(row, "toolName"),
    modelProvider: rowNullableString(row, "modelProvider"),
    modelId: rowNullableString(row, "modelId"),
    responseId: rowNullableString(row, "responseId"),
    stopReason: rowNullableString(row, "stopReason"),
    errorType: rowNullableString(row, "errorType"),
    durationMs: rowNullableNumber(row, "durationMs"),
    llmCalls: rowNullableNumber(row, "llmCalls"),
    toolCalls: rowNullableNumber(row, "toolCalls"),
    usage: eventUsage(row),
    details: parseEventDetails(row.detailsJson),
  };
}

function eventPageLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || (value ?? 0) < 1) return DEFAULT_EVENT_PAGE_LIMIT;
  return Math.min(value!, MAX_EVENT_PAGE_LIMIT);
}

function listRunEvents(
  runId: string,
  query: AgentAuditRunDetailQuery,
): { events: AgentAuditEventRecord[]; nextBeforeSequence?: number } {
  const beforeSequence =
    Number.isInteger(query.beforeSequence) && (query.beforeSequence ?? 0) > 0
      ? query.beforeSequence
      : undefined;
  const limit = eventPageLimit(query.eventLimit);
  const rows = db!
    .prepare(`SELECT
      event_id AS eventId, occurred_at_ms AS occurredAtMs, ingested_at_ms AS ingestedAtMs,
      run_sequence AS runSequence, run_id AS runId, event_type AS eventType, status,
      session_id AS sessionId, turn_id AS turnId, model_request_id AS modelRequestId,
      tool_call_id AS toolCallId, related_run_id AS relatedRunId, tool_name AS toolName,
      model_provider AS modelProvider, model_id AS modelId, response_id AS responseId,
      stop_reason AS stopReason, error_type AS errorType, duration_ms AS durationMs,
      llm_calls AS llmCalls, tool_calls AS toolCalls, input_tokens AS input,
      output_tokens AS output, cache_read_tokens AS cacheRead,
      cache_write_tokens AS cacheWrite, total_tokens AS totalTokens, cost_usd AS costUsd,
      details_json AS detailsJson
      FROM audit_events
      WHERE run_id = $runId
        AND ($beforeSequence IS NULL OR run_sequence < $beforeSequence)
      ORDER BY run_sequence DESC, event_id DESC
      LIMIT $limit`)
    .all({
      $runId: runId,
      $beforeSequence: beforeSequence ?? null,
      $limit: limit + 1,
    }) as unknown as Record<string, unknown>[];
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const events = rows.map(mapEventRow).toReversed();
  return {
    events,
    ...(hasMore && events[0] ? { nextBeforeSequence: events[0].runSequence } : {}),
  };
}

function listToolCalls(runId: string): {
  rows: AgentAuditToolCallSummary[];
  truncated: boolean;
} {
  const sourceRows = db!
    .prepare(`SELECT run_id AS runId, tool_call_id AS toolCallId, turn_id AS turnId,
      tool_name AS toolName, status, started_at_ms AS startedAtMs,
      ended_at_ms AS endedAtMs, duration_ms AS durationMs
      FROM audit_tool_calls WHERE run_id = ?
      ORDER BY started_at_ms DESC, tool_call_id DESC LIMIT ?`)
    .all(runId, RELATED_ROW_LIMIT + 1) as unknown as SqlRow[];
  const rows = sourceRows.map(
    (row): AgentAuditToolCallSummary => ({
      runId: rowString(row, "runId"),
      toolCallId: rowString(row, "toolCallId"),
      turnId: rowNullableString(row, "turnId"),
      toolName: rowString(row, "toolName"),
      status: rowEnum(row, "status", AUDIT_STATUSES),
      startedAtMs: rowNumber(row, "startedAtMs"),
      endedAtMs: rowNullableNumber(row, "endedAtMs"),
      durationMs: rowNullableNumber(row, "durationMs"),
    }),
  );
  const truncated = rows.length > RELATED_ROW_LIMIT;
  if (truncated) rows.pop();
  return { rows: rows.toReversed(), truncated };
}

function listModelRequests(runId: string): {
  rows: AgentAuditModelRequestSummary[];
  truncated: boolean;
} {
  const sourceRows = db!
    .prepare(`SELECT run_id AS runId, model_request_id AS modelRequestId, turn_id AS turnId,
      model_provider AS modelProvider, model_id AS modelId, response_id AS responseId,
      status, started_at_ms AS startedAtMs, ended_at_ms AS endedAtMs,
      duration_ms AS durationMs, stop_reason AS stopReason, input_tokens AS input,
      output_tokens AS output, cache_read_tokens AS cacheRead,
      cache_write_tokens AS cacheWrite, total_tokens AS totalTokens, cost_usd AS costUsd
      FROM audit_model_requests WHERE run_id = ?
      ORDER BY started_at_ms DESC, model_request_id DESC LIMIT ?`)
    .all(runId, RELATED_ROW_LIMIT + 1) as unknown as SqlRow[];
  const truncated = sourceRows.length > RELATED_ROW_LIMIT;
  if (truncated) sourceRows.pop();
  const rows = sourceRows.map(
    (row): AgentAuditModelRequestSummary => ({
      runId: rowString(row, "runId"),
      modelRequestId: rowString(row, "modelRequestId"),
      turnId: rowNullableString(row, "turnId"),
      modelProvider: rowString(row, "modelProvider"),
      modelId: rowString(row, "modelId"),
      responseId: rowNullableString(row, "responseId"),
      status: rowEnum(row, "status", AUDIT_STATUSES),
      startedAtMs: rowNumber(row, "startedAtMs"),
      endedAtMs: rowNullableNumber(row, "endedAtMs"),
      durationMs: rowNullableNumber(row, "durationMs"),
      stopReason: rowNullableString(row, "stopReason"),
      usage: eventUsage(row) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        costUsd: 0,
      },
    }),
  );
  return { rows: rows.toReversed(), truncated };
}

function getRun(runId: string, query: AgentAuditRunDetailQuery): AgentAuditRunDetail | null {
  const sourceRun = db!.prepare(`${runSelectSql()} WHERE r.run_id = ?`).get(runId) as unknown as
    | SqlRow
    | undefined;
  if (!sourceRun) return null;
  const run = mapRunRow(sourceRun);
  const eventPage = listRunEvents(runId, query);
  const tools = listToolCalls(runId);
  const modelRequests = listModelRequests(runId);
  const childRuns = (
    db!
      .prepare(
        `${runSelectSql()} WHERE r.parent_run_id = ?
       ORDER BY r.started_at_ms DESC, r.run_id DESC LIMIT ?`,
      )
      .all(runId, RELATED_ROW_LIMIT + 1) as unknown as SqlRow[]
  ).map(mapRunRow);
  const childRunsTruncated = childRuns.length > RELATED_ROW_LIMIT;
  if (childRunsTruncated) childRuns.pop();
  return {
    run,
    ...eventPage,
    tools: tools.rows,
    modelRequests: modelRequests.rows,
    childRuns: childRuns.toReversed(),
    relatedTruncated: tools.truncated || modelRequests.truncated || childRunsTruncated,
  };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function health(): AuditWorkerHealth {
  const eventCount = db!.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as
    | CountRow
    | undefined;
  const runCount = db!.prepare("SELECT COUNT(*) AS count FROM audit_runs").get() as
    | CountRow
    | undefined;
  return {
    databaseBytes:
      fileSize(init.dbPath) + fileSize(`${init.dbPath}-wal`) + fileSize(`${init.dbPath}-shm`),
    eventCount: eventCount?.count ?? 0,
    runCount: runCount?.count ?? 0,
  };
}

function expiredRunIds(nowMs: number): string[] {
  const rows = db!
    .prepare(
      `SELECT run_id AS runId FROM audit_runs
       WHERE expires_at_ms <= ?
       ORDER BY expires_at_ms, run_id
       LIMIT ?`,
    )
    .all(nowMs, RETENTION_RUN_BATCH_SIZE) as unknown as Array<{ runId: string }>;
  return rows.map((row) => row.runId);
}

function deleteRuns(table: string, runIds: string[]): number {
  if (runIds.length === 0) return 0;
  const placeholders = runIds.map(() => "?").join(", ");
  const result = db!
    .prepare(`DELETE FROM ${table} WHERE run_id IN (${placeholders})`)
    .run(...runIds);
  return Number(result.changes);
}

function runRetention(nowMs: number): { deleted: number; more: boolean } {
  const runIds = expiredRunIds(nowMs);
  if (runIds.length === 0) return { deleted: 0, more: false };
  db!.exec("BEGIN IMMEDIATE");
  try {
    let deleted = 0;
    deleted += deleteRuns("audit_events", runIds);
    deleted += deleteRuns("audit_tool_calls", runIds);
    deleted += deleteRuns("audit_model_requests", runIds);
    deleted += deleteRuns("audit_runs", runIds);
    db!.exec("COMMIT");
    secureDatabaseFiles();
    return { deleted, more: runIds.length === RETENTION_RUN_BATCH_SIZE };
  } catch (error) {
    db!.exec("ROLLBACK");
    throw error;
  }
}

function handleQuery(request: Exclude<AuditWorkerRequest, { type: "append" }>): void {
  try {
    if (request.type === "list_runs") {
      post({
        type: "list_runs_result",
        requestId: request.requestId,
        result: listRuns(request.query),
      });
    } else if (request.type === "get_run") {
      post({
        type: "get_run_result",
        requestId: request.requestId,
        result: getRun(request.runId, request.query),
      });
    } else if (request.type === "health") {
      post({ type: "health_result", requestId: request.requestId, result: health() });
    } else if (request.type === "retention") {
      const result = runRetention(request.nowMs);
      if (!result.more) {
        db!.exec("PRAGMA wal_checkpoint(PASSIVE)");
        secureDatabaseFiles();
      }
      post({ type: "retention_result", requestId: request.requestId, ...result });
    } else {
      db!.exec("PRAGMA optimize");
      db!.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      secureDatabaseFiles();
      db!.close();
      db = undefined;
      post({ type: "close_result", requestId: request.requestId });
    }
  } catch (error) {
    const response = { requestId: request.requestId, error: errorText(error) };
    if (request.type === "list_runs") post({ type: "list_runs_result", ...response });
    else if (request.type === "get_run") post({ type: "get_run_result", ...response });
    else if (request.type === "health") post({ type: "health_result", ...response });
    else if (request.type === "retention") post({ type: "retention_result", ...response });
    else post({ type: "close_result", ...response });
  }
}

function handleMessage(request: AuditWorkerRequest): void {
  if (request.type !== "append") {
    handleQuery(request);
    return;
  }
  try {
    post({
      type: "append_result",
      batchId: request.batchId,
      written: appendEvents(request.events),
    });
  } catch (error) {
    post({
      type: "append_result",
      batchId: request.batchId,
      written: 0,
      error: errorText(error),
    });
  }
}

function main(): void {
  if (!parentPort) return;
  try {
    db = openDatabase();
    statements = prepareAuditStatements(db);
    parentPort.on("message", handleMessage);
    post({ type: "ready" });
  } catch (error) {
    post({ type: "fatal", error: errorText(error) });
  }
}

main();
