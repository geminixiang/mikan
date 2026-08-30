import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";
import { AgentAuditStore, type AgentAuditEventInput } from "../audit/index.js";
import { createOfficeAddress } from "../office/index.js";

const dirs: string[] = [];

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mikan-audit-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function startRun(store: AgentAuditStore, conversationId = "C1") {
  return store.startRun({
    officeKey: `v1-${conversationId}`,
    address: createOfficeAddress("slack", conversationId),
    sessionKey: conversationId,
    runKind: "interactive",
  });
}

function recordCompletedRun(
  store: AgentAuditStore,
  options: { conversationId: string; toolName?: string; startedAtMs: number },
): string {
  const run = startRun(store, options.conversationId);
  run.record({ type: "run_admitted", status: "admitted", occurredAtMs: options.startedAtMs });
  run.record({ type: "run_started", status: "running", occurredAtMs: options.startedAtMs + 1 });
  if (options.toolName) {
    run.record({
      type: "tool_started",
      status: "running",
      occurredAtMs: options.startedAtMs + 2,
      toolCallId: `${options.conversationId}-tool`,
      toolName: options.toolName,
    });
    run.record({
      type: "tool_completed",
      status: "completed",
      occurredAtMs: options.startedAtMs + 3,
      toolCallId: `${options.conversationId}-tool`,
      toolName: options.toolName,
      durationMs: 1,
    });
  }
  run.record({
    type: "run_completed",
    status: "completed",
    occurredAtMs: options.startedAtMs + 4,
    durationMs: 4,
    llmCalls: 1,
    toolCalls: options.toolName ? 1 : 0,
    usage: {
      input: 2,
      output: 3,
      cacheRead: 5,
      cacheWrite: 7,
      totalTokens: 17,
      costUsd: 0.01,
    },
  });
  return run.runId;
}

describe("AgentAuditStore", () => {
  test("writes normalized events and query projections", async () => {
    const stateDir = tempStateDir();
    const store = new AgentAuditStore({ stateDir, retentionIntervalMs: 86_400_000 });
    const parent = startRun(store);
    parent.record({ type: "run_admitted", status: "admitted" });
    parent.record({ type: "run_started", status: "running", sessionId: "session-1" });
    parent.record({
      type: "model_request_started",
      status: "running",
      modelRequestId: "model-1",
      turnId: "turn-1",
      modelProvider: "faux",
      modelId: "faux-1",
    });
    parent.record({
      type: "model_request_completed",
      status: "completed",
      modelRequestId: "model-1",
      turnId: "turn-1",
      modelProvider: "faux",
      modelId: "faux-1",
      responseId: "response-1",
      stopReason: "toolUse",
      durationMs: 20,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        costUsd: 0.02,
      },
    });
    parent.record({
      type: "tool_started",
      status: "running",
      turnId: "turn-1",
      toolCallId: "tool-1",
      toolName: "bash",
    });
    parent.record({
      type: "tool_completed",
      status: "completed",
      turnId: "turn-1",
      toolCallId: "tool-1",
      toolName: "bash",
      durationMs: 7,
    });
    const child = parent.child({ runKind: "subagent", parentToolCallId: "tool-1" });
    child.record({ type: "run_admitted", status: "admitted" });
    child.record({ type: "run_completed", status: "completed", durationMs: 3 });
    parent.record({
      type: "run_completed",
      status: "completed",
      durationMs: 30,
      llmCalls: 1,
      toolCalls: 1,
      stopReason: "stop",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        costUsd: 0.02,
      },
    });
    // A later settlement failure must not overwrite the first terminal outcome.
    parent.record({ type: "run_failed", status: "failed", errorType: "late_failure" });

    await store.flush();

    const page = await store.listRuns({ toolName: "bash" });
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]).toMatchObject({
      runId: parent.runId,
      status: "completed",
      modelProvider: "faux",
      modelId: "faux-1",
      totalTokens: 18,
      toolCalls: 1,
    });

    const detail = await store.getRun(parent.runId);
    expect(detail?.events.map((event) => event.eventType)).toEqual([
      "run_admitted",
      "run_started",
      "model_request_started",
      "model_request_completed",
      "tool_started",
      "tool_completed",
      "run_completed",
    ]);
    expect(detail?.modelRequests[0]).toMatchObject({
      modelRequestId: "model-1",
      responseId: "response-1",
    });
    expect(detail?.modelRequests[0]?.usage.totalTokens).toBe(18);
    expect(detail?.tools[0]).toMatchObject({ toolCallId: "tool-1", toolName: "bash" });
    expect(detail?.childRuns[0]).toMatchObject({
      runId: child.runId,
      parentRunId: parent.runId,
      parentToolCallId: "tool-1",
    });

    await store.close();
  });

  test("filters by conversation, run, tool, time, and stable cursor", async () => {
    const store = new AgentAuditStore({
      stateDir: tempStateDir(),
      retentionIntervalMs: 86_400_000,
    });
    const first = recordCompletedRun(store, {
      conversationId: "C1",
      toolName: "read",
      startedAtMs: 1_000,
    });
    const second = recordCompletedRun(store, {
      conversationId: "C1",
      toolName: "bash",
      startedAtMs: 2_000,
    });
    recordCompletedRun(store, { conversationId: "C2", startedAtMs: 3_000 });
    await store.flush();

    expect((await store.listRuns({ conversationId: "C1" })).runs.map((run) => run.runId)).toEqual([
      second,
      first,
    ]);
    expect((await store.listRuns({ runId: first })).runs.map((run) => run.runId)).toEqual([first]);
    expect((await store.listRuns({ officeKeys: ["v1-C1"] })).runs.map((run) => run.runId)).toEqual([
      second,
      first,
    ]);
    expect((await store.listRuns({ officeKeys: [] })).runs).toEqual([]);
    expect((await store.listRuns({ toolName: "bash" })).runs.map((run) => run.runId)).toEqual([
      second,
    ]);
    expect(
      (await store.listRuns({ fromMs: 1_500, toMs: 2_500 })).runs.map((run) => run.runId),
    ).toEqual([second]);

    const firstPage = await store.listRuns({ conversationId: "C1", limit: 1 });
    expect(firstPage.runs.map((run) => run.runId)).toEqual([second]);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = await store.listRuns({
      conversationId: "C1",
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.runs.map((run) => run.runId)).toEqual([first]);

    await store.close();
  });

  test("pages a complete run timeline with bounded detail responses", async () => {
    const store = new AgentAuditStore({
      stateDir: tempStateDir(),
      retentionIntervalMs: 86_400_000,
    });
    const run = startRun(store);
    run.record({ type: "run_admitted", status: "admitted" });
    for (let index = 0; index < 450; index++) {
      run.record({ type: "turn_started", status: "running", turnId: `turn-${index}` });
    }
    run.record({ type: "run_completed", status: "completed" });
    await store.flush();

    const seen: number[] = [];
    let beforeSequence: number | undefined;
    do {
      const detail = await store.getRun(run.runId, { beforeSequence, eventLimit: 200 });
      expect(detail).not.toBeNull();
      seen.push(...detail!.events.map((event) => event.runSequence));
      beforeSequence = detail!.nextBeforeSequence;
    } while (beforeSequence);

    expect(seen).toHaveLength(452);
    expect(new Set(seen).size).toBe(452);
    expect(seen.toSorted((left, right) => left - right)).toEqual(
      Array.from({ length: 452 }, (_, index) => index + 1),
    );
    await store.close();
  });

  test("handles malformed private database rows predictably", async () => {
    const stateDir = tempStateDir();
    const store = new AgentAuditStore({ stateDir, retentionIntervalMs: 86_400_000 });
    const run = startRun(store);
    run.record({
      type: "run_admitted",
      status: "admitted",
      details: { sourceEventType: "message" },
    });
    run.record({ type: "run_completed", status: "completed" });
    await store.flush();
    await store.close();

    const database = new DatabaseSync(join(stateDir, "audit", "audit.sqlite"));
    database
      .prepare("UPDATE audit_events SET details_json = ? WHERE run_id = ? AND run_sequence = 1")
      .run('{"prompt":"secret","sourceEventType":" message "}', run.runId);
    database
      .prepare("UPDATE audit_events SET details_json = ? WHERE run_id = ? AND run_sequence = 2")
      .run("{", run.runId);
    database.close();

    const reopened = new AgentAuditStore({ stateDir, retentionIntervalMs: 86_400_000 });
    const details = (await reopened.getRun(run.runId))?.events.map((event) => event.details);
    expect(details).toEqual([{ sourceEventType: "message" }, {}]);
    expect(JSON.stringify(details)).not.toContain("secret");
    await reopened.close();

    const corrupt = new DatabaseSync(join(stateDir, "audit", "audit.sqlite"));
    corrupt.prepare("UPDATE audit_runs SET status = ? WHERE run_id = ?").run("unknown", run.runId);
    corrupt.close();

    const invalid = new AgentAuditStore({ stateDir, retentionIntervalMs: 86_400_000 });
    await expect(invalid.listRuns()).rejects.toThrow("Invalid audit database row field: status");
    await invalid.close();
  });

  test("keeps the producer non-throwing and reports bounded queue drops", async () => {
    const store = new AgentAuditStore({
      stateDir: tempStateDir(),
      maxQueueEvents: 1,
      maxQueueBytes: 128 * 1_024,
      batchSize: 1,
      retentionIntervalMs: 86_400_000,
    });
    const run = startRun(store);

    const boundedDetails = { sourceEventType: "message" } as NonNullable<
      AgentAuditEventInput["details"]
    > & { unvisited?: string };
    Object.defineProperty(boundedDetails, "unvisited", {
      enumerable: true,
      get: () => {
        throw new Error("unknown detail key was visited");
      },
    });
    run.record({ type: "turn_started", status: "running", details: boundedDetails });

    const hostileDetails = {} as NonNullable<AgentAuditEventInput["details"]>;
    Object.defineProperty(hostileDetails, "sourceEventType", {
      enumerable: true,
      get: () => {
        throw new Error("hostile getter");
      },
    });
    expect(() => {
      run.record({
        type: "turn_started",
        status: "running",
        details: hostileDetails,
      });
      for (let index = 0; index < 1_000; index++) {
        run.record({
          type: "turn_started",
          status: "running",
          turnId: `turn-${index}`,
          details: { sourceEventType: "x".repeat(10_000) },
        });
      }
      run.record({ type: "run_completed", status: "completed" });
    }).not.toThrow();

    await store.flush();
    const health = await store.getHealth();
    expect(health.droppedEvents).toBeGreaterThan(0);
    expect(health.producerErrors).toBe(1);
    expect(health.degraded).toBe(true);
    expect((await store.getRun(run.runId))?.events[0]?.details).toEqual({
      sourceEventType: "message",
    });
    await store.close();
  });

  test("serializes concurrent first-boot migrations", async () => {
    const stateDir = tempStateDir();
    const left = new AgentAuditStore({ stateDir, retentionIntervalMs: 86_400_000 });
    const right = new AgentAuditStore({ stateDir, retentionIntervalMs: 86_400_000 });

    const [leftHealth, rightHealth] = await Promise.all([left.getHealth(), right.getHealth()]);
    expect(leftHealth.available).toBe(true);
    expect(rightHealth.available).toBe(true);

    await Promise.all([left.close(), right.close()]);
  });

  test("degrades without throwing when the audit worker cannot start", async () => {
    const stateDir = tempStateDir();
    const blockingPath = join(stateDir, "audit");
    writeFileSync(blockingPath, "not a directory");

    let store: AgentAuditStore | undefined;
    expect(() => {
      store = new AgentAuditStore({ stateDir });
      const run = startRun(store);
      run.record({ type: "run_admitted", status: "admitted" });
      run.record({ type: "run_completed", status: "completed" });
    }).not.toThrow();

    const health = await store!.getHealth();
    expect(health).toMatchObject({ available: false, degraded: true });
    expect(health.lastError).toBeTruthy();
    await store!.close();
  });

  test("expires metadata and protects database files with owner-only modes", async () => {
    const stateDir = tempStateDir();
    const store = new AgentAuditStore({
      stateDir,
      retentionDays: 1,
      retentionIntervalMs: 86_400_000,
    });
    const expiredAt = Date.now() - 2 * 24 * 60 * 60 * 1_000;
    const run = startRun(store);
    run.record({ type: "run_admitted", status: "admitted", occurredAtMs: expiredAt });
    for (let index = 0; index < 1_500; index++) {
      run.record({
        type: "turn_started",
        status: "running",
        occurredAtMs: expiredAt + index + 1,
        turnId: `expired-${index}`,
      });
    }
    run.record({
      type: "run_completed",
      status: "completed",
      occurredAtMs: expiredAt + 1_501,
    });
    await store.flush();

    expect((await store.listRuns()).runs).toHaveLength(1);
    expect(await store.runRetention()).toBeGreaterThan(1_000);
    expect((await store.listRuns()).runs).toHaveLength(0);
    expect(await store.getRun(run.runId)).toBeNull();
    expect(await store.getHealth()).toMatchObject({ eventCount: 0, runCount: 0 });

    const auditDir = join(stateDir, "audit");
    expect(existsSync(store.dbPath)).toBe(true);
    expect(statSync(auditDir).mode & 0o777).toBe(0o700);
    expect(statSync(store.dbPath).mode & 0o777).toBe(0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const path = `${store.dbPath}${suffix}`;
      if (existsSync(path)) expect(statSync(path).mode & 0o777).toBe(0o600);
    }

    await store.close();
  });
});
