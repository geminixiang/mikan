import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";
import { FileVaultManager } from "../vault/index.js";
import { handleAdminRequest, InMemoryAdminTokenStore } from "../adapters/web/admin/portal.js";
import type { AdminServices } from "../adapters/web/admin/types.js";

const CONVERSATION_ID = "C-SKILLS";
const ADDRESS = createOfficeAddress("slack", CONVERSATION_ID);

let base: string;
let workspaceDir: string;
let server: Server;
let origin: string;
let token: string;

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

async function get(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(
    `${origin}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`,
  );
  return { status: response.status, body: await response.json() };
}

async function post(path: string, body: object): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...body }),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "mikan-admin-skills-"));
  const stateDir = join(base, "state");
  workspaceDir = join(base, "workspace");
  mkdirSync(stateDir, { recursive: true });
  const workspace = createWorkspace({ root: workspaceDir, stateDir });
  workspace.office(ADDRESS).ensure();

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
    workspace,
  });
  server = started.server;
  origin = started.origin;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(base, { recursive: true, force: true });
});

describe("Admin skills mutation API", () => {
  test("creates a conversation-scoped skill", async () => {
    const created = await post("/admin/api/skills/mutate", {
      action: "save",
      scope: "conversation",
      source: "conversation",
      directory: "deploy-prod",
      name: "deploy-prod",
      description: "Ship to production",
      content: "Run the deploy script.",
      conversationId: CONVERSATION_ID,
    });

    expect(created).toMatchObject({
      status: 200,
      body: { ok: true, name: "deploy-prod", directory: "deploy-prod", source: "conversation" },
    });

    const skillPath = join(workspaceDir, officeKey(ADDRESS), "skills", "deploy-prod", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const listed = await get(`/admin/api/skills?conversationId=${CONVERSATION_ID}`);
    expect(listed.body.skills).toContainEqual(
      expect.objectContaining({ name: "deploy-prod", description: "Ship to production" }),
    );
  });

  test("creates a global skill", async () => {
    const created = await post("/admin/api/skills/mutate", {
      action: "save",
      scope: "global",
      source: "global",
      directory: "team-norms",
      name: "team-norms",
      description: "Use when discussing team conventions",
      content: "Follow the team style guide.",
      conversationId: CONVERSATION_ID,
    });
    expect(created.status).toBe(200);

    const path = join(workspaceDir, "skills", "team-norms", "SKILL.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("Use when discussing team conventions");
  });

  test("edits an existing skill in place", async () => {
    await post("/admin/api/skills/mutate", {
      action: "save",
      source: "conversation",
      directory: "runbook",
      name: "runbook",
      description: "First version",
      content: "v1",
      conversationId: CONVERSATION_ID,
    });

    const updated = await post("/admin/api/skills/mutate", {
      action: "save",
      source: "conversation",
      directory: "runbook",
      name: "runbook",
      description: "Second version",
      content: "v2",
      conversationId: CONVERSATION_ID,
    });
    expect(updated.status).toBe(200);

    const listed = await get(`/admin/api/skills?conversationId=${CONVERSATION_ID}`);
    expect(listed.body.skills).toContainEqual(
      expect.objectContaining({ name: "runbook", description: "Second version" }),
    );
  });

  test("deletes a skill", async () => {
    await post("/admin/api/skills/mutate", {
      action: "save",
      source: "conversation",
      directory: "throwaway",
      name: "throwaway",
      description: "Temporary",
      content: "x",
      conversationId: CONVERSATION_ID,
    });

    const deleted = await post("/admin/api/skills/mutate", {
      action: "delete",
      source: "conversation",
      directory: "throwaway",
      conversationId: CONVERSATION_ID,
    });
    expect(deleted).toMatchObject({ status: 200, body: { ok: true } });

    const listed = await get(`/admin/api/skills?conversationId=${CONVERSATION_ID}`);
    expect(listed.body.skills.map((s: { directory: string }) => s.directory)).not.toContain(
      "throwaway",
    );
  });

  test("rejects a delete for a skill that does not exist", async () => {
    const response = await post("/admin/api/skills/mutate", {
      action: "delete",
      source: "conversation",
      directory: "missing",
      conversationId: CONVERSATION_ID,
    });
    expect(response).toMatchObject({ status: 404, body: { error: "Skill not found" } });
  });

  test("rejects an invalid directory name", async () => {
    const response = await post("/admin/api/skills/mutate", {
      action: "save",
      source: "conversation",
      directory: "Not Valid!",
      name: "x",
      description: "y",
      content: "z",
      conversationId: CONVERSATION_ID,
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("directory must be");
  });

  test("rejects a missing description", async () => {
    const response = await post("/admin/api/skills/mutate", {
      action: "save",
      source: "conversation",
      directory: "no-desc",
      name: "no-desc",
      description: "",
      content: "body",
      conversationId: CONVERSATION_ID,
    });
    expect(response).toMatchObject({ status: 400, body: { error: "description is required" } });
  });

  test("rejects an invalid action", async () => {
    const response = await post("/admin/api/skills/mutate", {
      action: "wipe",
      source: "conversation",
      directory: "x",
      conversationId: CONVERSATION_ID,
    });
    expect(response.status).toBe(400);
  });

  test("rejects a path-escaping directory", async () => {
    const response = await post("/admin/api/skills/mutate", {
      action: "save",
      source: "conversation",
      directory: "../../etc",
      name: "x",
      description: "y",
      content: "z",
      conversationId: CONVERSATION_ID,
    });
    expect(response.status).toBe(400);
  });

  test("refuses to write through a symlinked skill directory", async () => {
    const skillsDir = join(workspaceDir, officeKey(ADDRESS), "skills");
    mkdirSync(skillsDir, { recursive: true });
    const outsideTarget = mkdtempSync(join(tmpdir(), "mikan-admin-skills-outside-"));
    symlinkSync(outsideTarget, join(skillsDir, "linked"));

    const response = await post("/admin/api/skills/mutate", {
      action: "save",
      source: "conversation",
      directory: "linked",
      name: "linked",
      description: "should not write",
      content: "x",
      conversationId: CONVERSATION_ID,
    });

    expect(response.status).toBe(500);
    expect(existsSync(join(outsideTarget, "SKILL.md"))).toBe(false);
    rmSync(outsideTarget, { recursive: true, force: true });
  });
});
