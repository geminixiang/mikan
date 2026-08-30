import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentAuditStore } from "../audit/index.js";
import { createOfficeAddress } from "../office/index.js";
import { FileVaultManager } from "../vault/index.js";
import { handleAdminRequest, InMemoryAdminTokenStore } from "../web/admin/portal.js";
import type { AdminServices } from "../web/admin/types.js";

let stateDir: string;
let server: Server;
let origin: string;
let token: string;
let audit: AgentAuditStore;

function startServer(services: AdminServices): Promise<{ server: Server; origin: string }> {
  const instance = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleAdminRequest(req, res, url, services).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    instance.listen(0, "127.0.0.1", () => {
      const address = instance.address() as AddressInfo;
      resolve({ server: instance, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(
    `${origin}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`,
  );
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "mikan-admin-audit-"));
  audit = new AgentAuditStore({ stateDir, retentionIntervalMs: 86_400_000 });
  const run = audit.startRun({
    officeKey: "v1-C1",
    address: createOfficeAddress("slack", "C1"),
    sessionKey: "C1",
    runKind: "interactive",
  });
  run.record({ type: "run_admitted", status: "admitted", occurredAtMs: 1_000 });
  run.record({
    type: "tool_started",
    status: "running",
    occurredAtMs: 1_001,
    toolCallId: "tool-1",
    toolName: "bash",
  });
  run.record({
    type: "tool_completed",
    status: "completed",
    occurredAtMs: 1_002,
    toolCallId: "tool-1",
    toolName: "bash",
  });
  run.record({ type: "run_completed", status: "completed", occurredAtMs: 1_003 });
  await audit.flush();

  const adminTokenStore = new InMemoryAdminTokenStore();
  token = adminTokenStore.create({
    platform: "slack",
    platformUserId: "U1",
    conversationId: "C1",
  }).token;
  const started = await startServer({
    vaultManager: new FileVaultManager(stateDir),
    linkTokenStore: { create: () => ({ token: "x", expiresAt: 0 }) } as never,
    adminTokenStore,
    audit,
  });
  server = started.server;
  origin = started.origin;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await audit.close();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("admin audit API", () => {
  test("renders a dedicated metadata-only Audit tab", async () => {
    const response = await fetch(`${origin}/admin?token=${encodeURIComponent(token)}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('data-tab="audit"');
    expect(html).toContain("Metadata-only lifecycle evidence");
    expect(html).toContain(
      "Prompt text, tool arguments/results, model content, and thinking are never stored",
    );
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Script(match[1])).not.toThrow();
    }
  });

  test("lists metadata by conversation and tool and returns a typed run timeline", async () => {
    const listed = await get(
      "/admin/api/audit/runs?platform=slack&conversationId=C1&toolName=bash",
    );
    expect(listed.status).toBe(200);
    const page = listed.body as { runs: Array<{ runId: string }> };
    expect(page.runs).toHaveLength(1);

    const detail = await get(
      `/admin/api/audit/run?runId=${encodeURIComponent(page.runs[0]!.runId)}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      run: { conversationId: "C1", status: "completed" },
      tools: [{ toolName: "bash", status: "completed" }],
    });
    expect(JSON.stringify(detail.body)).not.toContain("payload");
  });

  test("pages large run timelines through the Admin API", async () => {
    const run = audit.startRun({
      officeKey: "v1-C1",
      address: createOfficeAddress("slack", "C1"),
      sessionKey: "C1",
      runKind: "interactive",
    });
    for (let index = 0; index < 205; index++) {
      run.record({ type: "turn_started", status: "running", turnId: `turn-${index}` });
    }
    run.record({ type: "run_completed", status: "completed" });
    await audit.flush();

    const newest = await get(`/admin/api/audit/run?runId=${encodeURIComponent(run.runId)}`);
    expect(newest.status).toBe(200);
    const newestBody = newest.body as {
      events: Array<{ runSequence: number }>;
      nextBeforeSequence?: number;
    };
    expect(newestBody.events).toHaveLength(200);
    expect(newestBody.nextBeforeSequence).toBeTruthy();

    const earlier = await get(
      `/admin/api/audit/run?runId=${encodeURIComponent(run.runId)}` +
        `&beforeSequence=${newestBody.nextBeforeSequence}`,
    );
    expect(earlier.status).toBe(200);
    expect((earlier.body as { events: unknown[] }).events).toHaveLength(6);
  });

  test("validates time ranges and exposes health", async () => {
    const invalid = await get("/admin/api/audit/runs?from=not-a-date");
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: expect.stringContaining("from") });

    const health = await get("/admin/api/audit/health");
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      health: { available: true, eventCount: 4, runCount: 1 },
    });
  });

  test("requires the normal admin capability", async () => {
    const response = await fetch(`${origin}/admin/api/audit/health`);
    expect(response.status).toBe(403);
  });
});
