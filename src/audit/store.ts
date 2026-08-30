import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import * as log from "../log.js";
import type {
  AgentAuditChildRunOptions,
  AgentAuditEventDetails,
  AgentAuditEventEnvelope,
  AgentAuditEventInput,
  AgentAuditHealth,
  AgentAuditRun,
  AgentAuditRunDetail,
  AgentAuditRunDetailQuery,
  AgentAuditRunIdentity,
  AgentAuditRunPage,
  AgentAuditRunQuery,
  AgentAuditService,
  AgentAuditStoreOptions,
  AgentAuditUsage,
  AuditWorkerHealth,
  AuditWorkerRequest,
  AuditWorkerResponse,
} from "./types.js";

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_QUEUE_EVENTS = 5_000;
const DEFAULT_MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const TERMINAL_EVENT_RESERVE = 128;
const TERMINAL_BYTE_RESERVE = 64 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_DETAIL_STRING_LENGTH = 256;

interface PendingWorkerRequest {
  resolve: (response: AuditWorkerResponse) => void;
  reject: (error: Error) => void;
}

interface InFlightBatch {
  id: number;
  events: number;
  bytes: number;
}

type WorkerQueryRequest =
  | { type: "list_runs"; query: AgentAuditRunQuery }
  | { type: "get_run"; runId: string; query: AgentAuditRunDetailQuery }
  | { type: "health" }
  | { type: "retention"; nowMs: number }
  | { type: "close" };

interface PreparedIdentity {
  officeKey: string;
  platform: string;
  conversationId: string;
  sessionKey: string;
  runKind: AgentAuditRunIdentity["runKind"];
  runId: string;
  parentRunId?: string;
  parentToolCallId?: string;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function boundedString(value: string | undefined, max = MAX_ID_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizeDetails(details: AgentAuditEventDetails | undefined): AgentAuditEventDetails {
  if (!details) return {};
  const normalized: AgentAuditEventDetails = {};
  if (details.purpose === "agent" || details.purpose === "compaction") {
    normalized.purpose = details.purpose;
  }
  if (
    details.origin === "interactive" ||
    details.origin === "event" ||
    details.origin === "session_dream"
  ) {
    normalized.origin = details.origin;
  }
  if (
    details.compactionReason === "threshold" ||
    details.compactionReason === "overflow" ||
    details.compactionReason === "manual"
  ) {
    normalized.compactionReason = details.compactionReason;
  }
  const sourceEventType = boundedString(details.sourceEventType, 64);
  if (sourceEventType) normalized.sourceEventType = sourceEventType;
  const responseModel = boundedString(details.responseModel, MAX_DETAIL_STRING_LENGTH);
  if (responseModel) normalized.responseModel = responseModel;

  const numberKeys = [
    "messageCount",
    "toolCount",
    "toolResultCount",
    "attempt",
    "maxAttempts",
    "delayMs",
    "retainedMessages",
    "tokensBefore",
    "attachmentCount",
    "imageAttachmentCount",
  ] as const;
  for (const key of numberKeys) {
    const value = finiteNonNegative(details[key]);
    if (value !== undefined) normalized[key] = value;
  }
  const booleanKeys = ["success", "aborted", "budgetExceeded"] as const;
  for (const key of booleanKeys) {
    if (typeof details[key] === "boolean") normalized[key] = details[key];
  }
  return normalized;
}

function normalizeUsage(usage: AgentAuditUsage | undefined): AgentAuditUsage | undefined {
  if (!usage) return undefined;
  return {
    input: finiteNonNegative(usage.input) ?? 0,
    output: finiteNonNegative(usage.output) ?? 0,
    cacheRead: finiteNonNegative(usage.cacheRead) ?? 0,
    cacheWrite: finiteNonNegative(usage.cacheWrite) ?? 0,
    totalTokens: finiteNonNegative(usage.totalTokens) ?? 0,
    costUsd: finiteNonNegative(usage.costUsd) ?? 0,
  };
}

function prepareIdentity(identity: AgentAuditRunIdentity): PreparedIdentity {
  return {
    officeKey: boundedString(identity.officeKey) ?? "unknown",
    platform: boundedString(identity.address.platform) ?? "unknown",
    conversationId: boundedString(identity.address.conversationId) ?? "unknown",
    sessionKey: boundedString(identity.sessionKey) ?? "unknown",
    runKind: identity.runKind,
    runId: boundedString(identity.runId) ?? randomUUID(),
    ...(boundedString(identity.parentRunId)
      ? { parentRunId: boundedString(identity.parentRunId) }
      : {}),
    ...(boundedString(identity.parentToolCallId)
      ? { parentToolCallId: boundedString(identity.parentToolCallId) }
      : {}),
  };
}

function prepareEvent(
  identity: PreparedIdentity,
  sequence: number,
  retentionMs: number,
  input: AgentAuditEventInput,
): AgentAuditEventEnvelope {
  const occurredAtMs = finiteNonNegative(input.occurredAtMs) ?? Date.now();
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    ingestedAtMs: Date.now(),
    occurredAtMs,
    expiresAtMs: occurredAtMs + retentionMs,
    runSequence: sequence,
    runId: identity.runId,
    runKind: identity.runKind,
    officeKey: identity.officeKey,
    platform: identity.platform,
    conversationId: identity.conversationId,
    sessionKey: identity.sessionKey,
    ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}),
    ...(identity.parentToolCallId ? { parentToolCallId: identity.parentToolCallId } : {}),
    type: input.type,
    ...(input.status ? { status: input.status } : {}),
    ...(boundedString(input.sessionId) ? { sessionId: boundedString(input.sessionId) } : {}),
    ...(boundedString(input.turnId) ? { turnId: boundedString(input.turnId) } : {}),
    ...(boundedString(input.modelRequestId)
      ? { modelRequestId: boundedString(input.modelRequestId) }
      : {}),
    ...(boundedString(input.toolCallId) ? { toolCallId: boundedString(input.toolCallId) } : {}),
    ...(boundedString(input.relatedRunId)
      ? { relatedRunId: boundedString(input.relatedRunId) }
      : {}),
    ...(boundedString(input.toolName, 128) ? { toolName: boundedString(input.toolName, 128) } : {}),
    ...(boundedString(input.modelProvider, 128)
      ? { modelProvider: boundedString(input.modelProvider, 128) }
      : {}),
    ...(boundedString(input.modelId, 256) ? { modelId: boundedString(input.modelId, 256) } : {}),
    ...(boundedString(input.responseId) ? { responseId: boundedString(input.responseId) } : {}),
    ...(boundedString(input.stopReason, 128)
      ? { stopReason: boundedString(input.stopReason, 128) }
      : {}),
    ...(boundedString(input.errorType, 128)
      ? { errorType: boundedString(input.errorType, 128) }
      : {}),
    ...(finiteNonNegative(input.durationMs) !== undefined
      ? { durationMs: finiteNonNegative(input.durationMs) }
      : {}),
    ...(finiteNonNegative(input.llmCalls) !== undefined
      ? { llmCalls: finiteNonNegative(input.llmCalls) }
      : {}),
    ...(finiteNonNegative(input.toolCalls) !== undefined
      ? { toolCalls: finiteNonNegative(input.toolCalls) }
      : {}),
    ...(normalizeUsage(input.usage) ? { usage: normalizeUsage(input.usage) } : {}),
    details: normalizeDetails(input.details),
  };
}

function estimateEventBytes(event: AgentAuditEventEnvelope): number {
  let bytes = 256;
  for (const value of [
    event.runId,
    event.officeKey,
    event.platform,
    event.conversationId,
    event.sessionKey,
    event.sessionId,
    event.turnId,
    event.modelRequestId,
    event.toolCallId,
    event.relatedRunId,
    event.toolName,
    event.modelProvider,
    event.modelId,
    event.responseId,
    event.stopReason,
    event.errorType,
  ]) {
    bytes += value?.length ?? 0;
  }
  for (const [key, value] of Object.entries(event.details ?? {})) {
    bytes += key.length + String(value).length;
  }
  return bytes;
}

function isRunTerminalType(type: AgentAuditEventInput["type"]): boolean {
  return (
    type === "run_setup_failed" ||
    type === "run_completed" ||
    type === "run_failed" ||
    type === "run_aborted"
  );
}

function isTerminalEvent(event: AgentAuditEventEnvelope): boolean {
  return isRunTerminalType(event.type);
}

function auditWorkerUrl(): URL {
  const sourceExtension = fileURLToPath(import.meta.url).endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./worker${sourceExtension}`, import.meta.url);
}

function ensureAuditDirectory(stateDir: string): string {
  const auditDir = join(stateDir, "audit");
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(auditDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Audit path is not a private directory: ${auditDir}`);
  }
  chmodSync(auditDir, 0o700);
  return auditDir;
}

class NoopAgentAuditRun implements AgentAuditRun {
  constructor(
    readonly runId: string = randomUUID(),
    readonly parentRunId?: string,
    readonly runKind: AgentAuditRunIdentity["runKind"] = "interactive",
  ) {}

  record(_input: AgentAuditEventInput): void {}

  child(options: AgentAuditChildRunOptions): AgentAuditRun {
    return new NoopAgentAuditRun(options.runId, this.runId, options.runKind);
  }
}

class AgentAuditRunImpl implements AgentAuditRun {
  readonly runId: string;
  readonly runKind: AgentAuditRunIdentity["runKind"];
  readonly parentRunId?: string;
  private sequence = 0;
  private terminalRecorded = false;

  constructor(
    private readonly identity: PreparedIdentity,
    private readonly retentionMs: number,
    private readonly accept: (event: AgentAuditEventEnvelope) => void,
    private readonly producerError: () => void,
  ) {
    this.runId = identity.runId;
    this.runKind = identity.runKind;
    this.parentRunId = identity.parentRunId;
  }

  record(input: AgentAuditEventInput): void {
    try {
      if (isRunTerminalType(input.type) && this.terminalRecorded) return;
      const event = prepareEvent(this.identity, ++this.sequence, this.retentionMs, input);
      this.accept(event);
      if (isRunTerminalType(input.type)) this.terminalRecorded = true;
    } catch {
      this.producerError();
    }
  }

  child(options: AgentAuditChildRunOptions): AgentAuditRun {
    const childIdentity = prepareIdentity({
      officeKey: this.identity.officeKey,
      address: {
        platform: this.identity.platform as AgentAuditRunIdentity["address"]["platform"],
        conversationId: this.identity.conversationId,
      },
      sessionKey: this.identity.sessionKey,
      runKind: options.runKind,
      runId: options.runId,
      parentRunId: this.runId,
      parentToolCallId: options.parentToolCallId,
    });
    return new AgentAuditRunImpl(childIdentity, this.retentionMs, this.accept, this.producerError);
  }
}

export class AgentAuditStore implements AgentAuditService {
  readonly dbPath: string;
  private readonly retentionDays: number;
  private readonly retentionMs: number;
  private readonly maxQueueEvents: number;
  private readonly maxQueueBytes: number;
  private readonly batchSize: number;
  private readonly queue: Array<{ event: AgentAuditEventEnvelope; bytes: number }> = [];
  private readonly pendingRequests = new Map<number, PendingWorkerRequest>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly readyPromise: Promise<boolean>;
  private resolveReady!: (available: boolean) => void;
  private worker: Worker | undefined;
  private inFlight: InFlightBatch | undefined;
  private retentionTimer: NodeJS.Timeout | undefined;
  private workerStartupTimer: NodeJS.Timeout | undefined;
  private queueBytes = 0;
  private nextBatchId = 1;
  private nextRequestId = 1;
  private available = false;
  private startupSettled = false;
  private closing = false;
  private closed = false;
  private degraded = false;
  private droppedEvents = 0;
  private producerErrors = 0;
  private writeFailures = 0;
  private lastWriteAtMs: number | null = null;
  private lastRetentionAtMs: number | null = null;
  private lastError: string | null = null;
  private workerHealth: AuditWorkerHealth = { databaseBytes: 0, eventCount: 0, runCount: 0 };

  constructor(options: AgentAuditStoreOptions) {
    this.retentionDays = positiveInteger(options.retentionDays, DEFAULT_RETENTION_DAYS);
    this.retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
    this.maxQueueEvents = positiveInteger(options.maxQueueEvents, DEFAULT_MAX_QUEUE_EVENTS);
    this.maxQueueBytes = positiveInteger(options.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES);
    this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    let auditDir: string;
    try {
      auditDir = ensureAuditDirectory(options.stateDir);
      this.dbPath = join(auditDir, "audit.sqlite");
      this.startWorker();
      const interval = positiveInteger(options.retentionIntervalMs, DEFAULT_RETENTION_INTERVAL_MS);
      this.retentionTimer = setInterval(() => {
        void this.runRetention().catch((error: unknown) => {
          this.markDegraded(errorText(error));
        });
      }, interval);
      this.retentionTimer.unref();
    } catch (error) {
      this.dbPath = join(options.stateDir, "audit", "audit.sqlite");
      this.failWorker(errorText(error));
    }
  }

  startRun(identity: AgentAuditRunIdentity): AgentAuditRun {
    try {
      return new AgentAuditRunImpl(
        prepareIdentity(identity),
        this.retentionMs,
        (event) => this.enqueue(event),
        () => this.noteProducerError(),
      );
    } catch {
      this.noteProducerError();
      return new NoopAgentAuditRun();
    }
  }

  async listRuns(query: AgentAuditRunQuery = {}): Promise<AgentAuditRunPage> {
    const response = await this.requestWorker({ type: "list_runs", query });
    if (response.type !== "list_runs_result") {
      throw new Error("Invalid audit list response");
    }
    if (response.error || !response.result) {
      throw new Error(response.error ?? "Audit list response was empty");
    }
    return response.result;
  }

  async getRun(
    runId: string,
    query: AgentAuditRunDetailQuery = {},
  ): Promise<AgentAuditRunDetail | null> {
    const normalized = boundedString(runId);
    if (!normalized) throw new Error("runId is required");
    const response = await this.requestWorker({ type: "get_run", runId: normalized, query });
    if (response.type !== "get_run_result") {
      throw new Error("Invalid audit run response");
    }
    if (response.error) throw new Error(response.error);
    return response.result ?? null;
  }

  async getHealth(): Promise<AgentAuditHealth> {
    if (await this.readyPromise) {
      try {
        const response = await this.requestWorker({ type: "health" });
        if (response.type === "health_result" && response.result) {
          this.workerHealth = response.result;
        }
      } catch {
        // Local health still reports worker availability and the last error.
      }
    }
    return this.healthSnapshot();
  }

  async flush(): Promise<void> {
    const ready = await this.readyPromise;
    if (!ready || (this.queue.length === 0 && !this.inFlight)) return;
    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
      this.scheduleDrain();
    });
  }

  async runRetention(): Promise<number> {
    const nowMs = Date.now();
    let deleted = 0;
    let more = true;
    while (more) {
      const response = await this.requestWorker({ type: "retention", nowMs });
      if (response.type !== "retention_result") {
        throw new Error("Invalid audit retention response");
      }
      if (response.error) throw new Error(response.error);
      deleted += response.deleted ?? 0;
      more = response.more === true;
    }
    this.lastRetentionAtMs = Date.now();
    return deleted;
  }

  async close(timeoutMs = 5_000): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.workerStartupTimer) clearTimeout(this.workerStartupTimer);
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, timeoutMs))),
    ]);
    if (this.available && this.worker) {
      try {
        await Promise.race([
          this.requestWorker({ type: "close" }),
          new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, timeoutMs))),
        ]);
      } catch {
        // Shutdown must remain best-effort.
      }
    }
    this.closed = true;
    if (this.worker) await this.worker.terminate();
    this.available = false;
    this.resolveIdleWaiters();
  }

  private startWorker(): void {
    const worker = new Worker(auditWorkerUrl(), {
      workerData: { dbPath: this.dbPath, retentionMs: this.retentionMs },
      execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
    });
    this.worker = worker;
    this.workerStartupTimer = setTimeout(() => {
      if (!this.startupSettled)
        this.failWorker("Agent audit worker did not become ready in 10000ms");
    }, 10_000);
    this.workerStartupTimer.unref();
    worker.on("message", (response: AuditWorkerResponse) => this.handleWorkerResponse(response));
    worker.on("error", (error: Error) => this.failWorker(error.message));
    worker.on("exit", (code) => {
      if (!this.closed && code !== 0) this.failWorker(`Audit writer exited with code ${code}`);
    });
  }

  private handleWorkerResponse(response: AuditWorkerResponse): void {
    if (response.type === "ready") {
      if (this.workerStartupTimer) clearTimeout(this.workerStartupTimer);
      this.available = true;
      this.settleReady(true);
      this.scheduleDrain();
      return;
    }
    if (response.type === "fatal") {
      this.failWorker(response.error);
      return;
    }
    if (response.type === "append_result") {
      this.finishBatch(response);
      return;
    }
    const pending = this.pendingRequests.get(response.requestId);
    if (!pending) return;
    this.pendingRequests.delete(response.requestId);
    if (response.error) pending.reject(new Error(response.error));
    else pending.resolve(response);
  }

  private enqueue(event: AgentAuditEventEnvelope): void {
    if (this.closing || this.closed || (this.startupSettled && !this.available)) {
      this.droppedEvents++;
      this.degraded = true;
      return;
    }
    const bytes = estimateEventBytes(event);
    const terminal = isTerminalEvent(event);
    const pendingEvents = this.queue.length + (this.inFlight?.events ?? 0);
    const pendingBytes = this.queueBytes + (this.inFlight?.bytes ?? 0);
    const eventReserve = Math.min(TERMINAL_EVENT_RESERVE, Math.floor(this.maxQueueEvents / 4));
    const byteReserve = Math.min(TERMINAL_BYTE_RESERVE, Math.floor(this.maxQueueBytes / 4));
    const eventLimit = terminal
      ? this.maxQueueEvents
      : Math.max(1, this.maxQueueEvents - eventReserve);
    const byteLimit = terminal ? this.maxQueueBytes : Math.max(1, this.maxQueueBytes - byteReserve);
    if (pendingEvents >= eventLimit || pendingBytes + bytes > byteLimit) {
      this.droppedEvents++;
      this.degraded = true;
      return;
    }
    this.queue.push({ event, bytes });
    this.queueBytes += bytes;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (!this.available || !this.worker || this.inFlight || this.queue.length === 0) {
      this.resolveIdleWaiters();
      return;
    }
    setImmediate(() => this.sendNextBatch());
  }

  private sendNextBatch(): void {
    if (!this.available || !this.worker || this.inFlight || this.queue.length === 0) {
      this.resolveIdleWaiters();
      return;
    }
    const items = this.queue.splice(0, this.batchSize);
    const bytes = items.reduce((sum, item) => sum + item.bytes, 0);
    this.queueBytes -= bytes;
    const batchId = this.nextBatchId++;
    this.inFlight = { id: batchId, events: items.length, bytes };
    try {
      this.worker.postMessage({
        type: "append",
        batchId,
        events: items.map((item) => item.event),
      } satisfies AuditWorkerRequest);
    } catch (error) {
      this.finishBatch({
        type: "append_result",
        batchId,
        written: 0,
        error: errorText(error),
      });
    }
  }

  private finishBatch(response: Extract<AuditWorkerResponse, { type: "append_result" }>): void {
    const batch = this.inFlight;
    if (!batch || batch.id !== response.batchId) return;
    this.inFlight = undefined;
    if (response.error) {
      this.writeFailures++;
      this.droppedEvents += batch.events;
      this.markDegraded(response.error);
    } else {
      this.lastWriteAtMs = Date.now();
      this.degraded = this.droppedEvents > 0 || this.producerErrors > 0 || this.writeFailures > 0;
    }
    this.scheduleDrain();
  }

  private async requestWorker(request: WorkerQueryRequest): Promise<AuditWorkerResponse> {
    if (!(await this.readyPromise) || !this.worker || !this.available) {
      throw new Error(this.lastError ?? "Agent audit store is unavailable");
    }
    const requestId = this.nextRequestId++;
    return new Promise<AuditWorkerResponse>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });
      try {
        this.worker!.postMessage({ ...request, requestId } as AuditWorkerRequest);
      } catch (error) {
        this.pendingRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private noteProducerError(): void {
    this.producerErrors++;
    this.degraded = true;
  }

  private markDegraded(message: string): void {
    this.degraded = true;
    this.lastError = boundedString(message, 512) ?? "Unknown audit failure";
  }

  private failWorker(message: string): void {
    if (this.closed || (this.startupSettled && !this.available && this.lastError)) return;
    if (this.workerStartupTimer) clearTimeout(this.workerStartupTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.available = false;
    this.markDegraded(message);
    this.droppedEvents += this.queue.length + (this.inFlight?.events ?? 0);
    this.queue.length = 0;
    this.queueBytes = 0;
    this.inFlight = undefined;
    this.settleReady(false);
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error(this.lastError ?? "Agent audit store failed"));
    }
    this.pendingRequests.clear();
    this.resolveIdleWaiters();
    void this.worker?.terminate().catch(() => {});
    log.logWarning("Agent audit store unavailable", this.lastError ?? undefined);
  }

  private settleReady(available: boolean): void {
    if (this.startupSettled) return;
    this.startupSettled = true;
    this.resolveReady(available);
  }

  private resolveIdleWaiters(): void {
    if (this.queue.length > 0 || this.inFlight) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private healthSnapshot(): AgentAuditHealth {
    return {
      enabled: true,
      available: this.available,
      degraded: this.degraded || !this.available,
      dbPath: this.dbPath,
      retentionDays: this.retentionDays,
      queueDepth: this.queue.length,
      queueBytes: this.queueBytes,
      inFlightEvents: this.inFlight?.events ?? 0,
      droppedEvents: this.droppedEvents,
      producerErrors: this.producerErrors,
      writeFailures: this.writeFailures,
      lastWriteAtMs: this.lastWriteAtMs,
      lastRetentionAtMs: this.lastRetentionAtMs,
      lastError: this.lastError,
      ...this.workerHealth,
    };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
