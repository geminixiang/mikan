import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { handleAdminRequest } from "../src/web/admin/portal.js";
import { InMemoryAdminTokenStore } from "../src/web/admin/store.js";
import { FileVaultManager } from "../src/vault/index.js";
import type { AdminServices } from "../src/web/admin/types.js";
import { createOfficeAddress, officeDirName } from "../src/office-address.js";
import { OfficeRegistry } from "../src/office-registry.js";

const CONVERSATION_ID = "C03045VJJAY";
const CONVERSATION_ADDRESS = createOfficeAddress("slack", CONVERSATION_ID);

let base: string;
let stateDir: string;
let workingDir: string;
let repo: string;
let source: string;
let server: Server;
let origin: string;
let token: string;

/** Exercises the real route table, not the handlers in isolation. */
function startServer(services: AdminServices): Promise<{ server: Server; origin: string }> {
  const srv = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleAdminRequest(req, res, url, services).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address() as AddressInfo;
      resolve({ server: srv, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(
    `${origin}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`,
  );
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: object): Promise<{ status: number; body: any }> {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...body }),
  });
  return { status: res.status, body: await res.json() };
}

function globalPackages(): string[] {
  const raw = readFileSync(join(stateDir, "settings.json"), "utf-8");
  return (JSON.parse(raw) as { packages?: string[] }).packages ?? [];
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "mikan-admin-pkg-"));
  stateDir = join(base, "state");
  workingDir = join(base, "workspace");
  mkdirSync(stateDir, { recursive: true });
  new OfficeRegistry(stateDir).recordOffice(CONVERSATION_ADDRESS);
  mkdirSync(join(workingDir, officeDirName(CONVERSATION_ADDRESS)), { recursive: true });
  process.env.MIKAN_STATE_DIR = stateDir;
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
    }),
  );

  repo = mkdtempSync(join(base, "repo-"));
  const ext = join(repo, "extensions", "reporter");
  mkdirSync(ext, { recursive: true });
  writeFileSync(join(ext, "index.mjs"), "export function activate() {}");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], {
    cwd: repo,
  });
  source = `file://${repo}`;

  const adminTokenStore = new InMemoryAdminTokenStore();
  token = adminTokenStore.create({
    platform: "slack",
    platformUserId: "U1",
    conversationId: CONVERSATION_ID,
  }).token;

  const started = await startServer({
    vaultManager: new FileVaultManager(stateDir),
    linkTokenStore: { create: () => ({ token: "x", expiresAt: 0 }) } as never,
    adminTokenStore,
    workingDir,
  });
  server = started.server;
  origin = started.origin;
});

afterEach(async () => {
  delete process.env.MIKAN_STATE_DIR;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

describe("GET /admin/api/packages", () => {
  test("returns both scopes, empty on a fresh host", async () => {
    const { status, body } = await get("/admin/api/packages");
    expect(status).toBe(200);
    expect(body).toMatchObject({ conversationId: CONVERSATION_ID, global: [], conversation: [] });
  });

  test("rejects a missing token", async () => {
    const res = await fetch(`${origin}/admin/api/packages`);
    expect(res.status).toBe(403);
  });
});

describe("POST /admin/api/packages/mutate", () => {
  test("add fetches, persists, and the inventory reports what it provides", async () => {
    const added = await post("/admin/api/packages/mutate", {
      action: "add",
      scope: "global",
      source,
    });
    expect(added.status).toBe(200);
    expect(globalPackages()).toEqual([source]);

    const { body } = await get("/admin/api/packages");
    expect(body.global[0]).toMatchObject({ ready: true, extensions: ["reporter"] });
  });

  test("a bad source answers 400 with git's message and persists nothing", async () => {
    const res = await post("/admin/api/packages/mutate", {
      action: "add",
      scope: "global",
      source: "file:///nope/missing",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(globalPackages()).toEqual([]);
  });

  test("an unparseable source answers 400, not 500", async () => {
    const res = await post("/admin/api/packages/mutate", {
      action: "add",
      scope: "global",
      source: "not a source",
    });
    expect(res.status).toBe(400);
  });

  test("an unknown action is rejected", async () => {
    const res = await post("/admin/api/packages/mutate", {
      action: "destroy",
      scope: "global",
      source,
    });
    expect(res.status).toBe(400);
  });

  test("an empty source is rejected", async () => {
    const res = await post("/admin/api/packages/mutate", {
      action: "add",
      scope: "global",
      source: "   ",
    });
    expect(res.status).toBe(400);
  });

  test("conversation scope writes the conversation list, not the global one", async () => {
    await post("/admin/api/packages/mutate", { action: "add", scope: "conversation", source });
    expect(globalPackages()).toEqual([]);

    const { body } = await get("/admin/api/packages");
    expect(body.conversation).toHaveLength(1);
    expect(body.global).toHaveLength(0);
  });

  test("remove drops the entry", async () => {
    await post("/admin/api/packages/mutate", { action: "add", scope: "global", source });
    const removed = await post("/admin/api/packages/mutate", {
      action: "remove",
      scope: "global",
      source,
    });
    expect(removed.status).toBe(200);
    expect(globalPackages()).toEqual([]);
  });

  test("removing something undeclared answers 404", async () => {
    const res = await post("/admin/api/packages/mutate", {
      action: "remove",
      scope: "global",
      source,
    });
    expect(res.status).toBe(404);
  });

  test("refresh on an undeclared source answers 400", async () => {
    const res = await post("/admin/api/packages/mutate", {
      action: "refresh",
      scope: "global",
      source,
    });
    expect(res.status).toBe(400);
  });

  test("a conversationId outside the token's scope is refused", async () => {
    const res = await post("/admin/api/packages/mutate", {
      action: "add",
      scope: "conversation",
      source,
      conversationId: "../escape",
    });
    expect(res.status).toBe(403);
  });
});
