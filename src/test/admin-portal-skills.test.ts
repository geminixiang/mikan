import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";
import { handleAdminRequest, InMemoryAdminTokenStore } from "../adapters/web/admin/portal.js";
import type { AdminServices } from "../adapters/web/admin/types.js";
import { SessionStore } from "../sessions/session-store.js";

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

interface ErrorBody {
  error: string;
}

interface SkillsListBody {
  skills: { name: string; description: string; directory: string }[];
}

interface JsonResponse<T> {
  status: number;
  body: T;
}

async function readJsonResponse<T>(response: Response): Promise<JsonResponse<T>> {
  return { status: response.status, body: JSON.parse(await response.text()) };
}

async function get<T>(path: string): Promise<JsonResponse<T>> {
  const response = await fetch(
    `${origin}${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`,
  );
  return readJsonResponse<T>(response);
}

async function post<T = ErrorBody>(path: string, body: object): Promise<JsonResponse<T>> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...body }),
  });
  return readJsonResponse<T>(response);
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
    linkTokenStore: { create: () => ({ token: "x" }) },
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

describe("Admin conversation scope", () => {
  test("every conversation endpoint refuses an invalid conversation the same way", async () => {
    const query = "conversationId=..%2Fescape";
    const responses = await Promise.all([
      get(`/admin/api/conversation-state?${query}`),
      get(`/admin/api/workspace/tree?${query}`),
      get(`/admin/api/workspace/file?${query}&path=MEMORY.md`),
      get(`/admin/api/skills?${query}`),
      get(`/admin/api/skills/file?${query}&source=conversation&directory=demo`),
      get(`/admin/api/mcp-servers?${query}`),
      get(`/admin/api/conversations/events?${query}`),
      post("/admin/api/conversations/model", {
        conversationId: "../escape",
        provider: "anthropic",
        model: "claude",
      }),
      post("/admin/api/conversations/visibility", {
        conversationId: "../escape",
        visibility: "private",
      }),
      post("/admin/api/conversations/login-link", { conversationId: "../escape" }),
      post("/admin/api/skills/mutate", {
        conversationId: "../escape",
        action: "delete",
        source: "conversation",
        directory: "demo",
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual(responses.map(() => 403));
  });
});

describe("Admin response metadata", () => {
  test("returns workspace tree navigation fields without unused metadata", async () => {
    const scratch = join(workspaceDir, officeKey(ADDRESS), "scratch");
    mkdirSync(join(scratch, "a", "b", "c"), { recursive: true });
    writeFileSync(join(scratch, "file.txt"), "preview me");

    const response = await get<{ tree: unknown }>(
      `/admin/api/workspace/tree?conversationId=${CONVERSATION_ID}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.tree).toEqual({
      name: ".",
      path: "",
      type: "dir",
      children: [
        {
          name: "scratch",
          path: "scratch",
          type: "dir",
          children: [
            {
              name: "a",
              path: "scratch/a",
              type: "dir",
              children: [
                {
                  name: "b",
                  path: "scratch/a/b",
                  type: "dir",
                  children: [{ name: "c", path: "scratch/a/b/c", type: "dir" }],
                },
              ],
            },
            { name: "file.txt", path: "scratch/file.txt", type: "file" },
          ],
        },
      ],
    });
  });

  test("returns session usage without an unused session id", async () => {
    const office = createWorkspace({ root: workspaceDir, stateDir: join(base, "state") }).office(
      ADDRESS,
    );
    const session = await SessionStore.open(office, ADDRESS.conversationId);
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    await session.close();

    const response = await get<{ sessions: unknown[] }>("/admin/api/session-usage");

    expect(response.status).toBe(200);
    expect(response.body.sessions).toHaveLength(1);
    expect(response.body.sessions[0]).toMatchObject({
      conversationId: CONVERSATION_ID,
      input: 1,
      output: 2,
      total: 3,
    });
    expect(response.body.sessions[0]).not.toHaveProperty("sessionId");
  });
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
    const listed = await get<SkillsListBody>(`/admin/api/skills?conversationId=${CONVERSATION_ID}`);
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

    const listed = await get<SkillsListBody>(`/admin/api/skills?conversationId=${CONVERSATION_ID}`);
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

    const listed = await get<SkillsListBody>(`/admin/api/skills?conversationId=${CONVERSATION_ID}`);
    expect(listed.body.skills.map((s) => s.directory)).not.toContain("throwaway");
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

interface Listed {
  name: string;
  source: string;
  directory: string;
  enabled: boolean;
  globalRule: string | null;
  conversationRule: string | null;
}
interface ListBody {
  skills: Listed[];
  prompt: { listed: number; total: number; chars: number };
}

function writeSkill(root: string, directory: string, name: string): void {
  mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(
    join(root, directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} instructions\n---\nBody`,
  );
}

const skillStates = (body: ListBody) =>
  Object.fromEntries(
    body.skills.map((s) => [s.name, [s.enabled, s.globalRule, s.conversationRule]]),
  );

describe("Admin skill enablement", () => {
  beforeEach(() => {
    const stateDir = join(base, "state");
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({ llm: { provider: "anthropic", model: "m", thinkingLevel: "off" } }),
    );
    writeSkill(join(workspaceDir, "skills"), "bundle/vendors/alpha", "alpha");
    writeSkill(join(workspaceDir, "skills"), "beta", "beta");
  });

  afterEach(() => {});

  test("lists nested skills as the runner loads them, all enabled by default", async () => {
    const listed = await get<ListBody>(`/admin/api/skills?conversationId=${CONVERSATION_ID}`);
    expect(listed.status).toBe(200);
    expect(listed.body.skills.map((s) => [s.name, s.directory])).toEqual([
      ["beta", "beta"],
      ["alpha", "bundle/vendors/alpha"],
    ]);
    expect(skillStates(listed.body)).toEqual({
      alpha: [true, null, null],
      beta: [true, null, null],
    });
    expect(listed.body.prompt).toMatchObject({ listed: 2, total: 2 });
  });

  test("a global toggle writes -path/+path and a conversation cycles inherit, + and -", async () => {
    const toggle = (body: object) =>
      post<ListBody>("/admin/api/skills/toggle", { conversationId: CONVERSATION_ID, ...body });

    let result = await toggle({
      scope: "global",
      source: "global",
      directory: "bundle/vendors/alpha",
      state: "unload",
    });
    expect(result.status).toBe(200);
    expect(skillStates(result.body).alpha).toEqual([false, "-", null]);
    expect(result.body.prompt).toMatchObject({ listed: 1, total: 2 });
    expect(JSON.parse(readFileSync(join(base, "state", "settings.json"), "utf-8")).skills).toEqual([
      "-bundle/vendors/alpha",
    ]);

    result = await toggle({
      scope: "conversation",
      source: "global",
      directory: "bundle/vendors/alpha",
      state: "load",
    });
    expect(skillStates(result.body).alpha).toEqual([true, "-", "+"]);
    result = await toggle({
      scope: "conversation",
      source: "global",
      directory: "beta",
      state: "unload",
    });
    expect(skillStates(result.body).beta).toEqual([false, null, "-"]);
    const office = createWorkspace({ root: workspaceDir, stateDir: join(base, "state") }).office(
      ADDRESS,
    );
    expect(
      JSON.parse(readFileSync(join(office.stateDir, "settings.json"), "utf-8")).skills,
    ).toEqual(["+bundle/vendors/alpha", "-beta"]);

    result = await toggle({
      scope: "conversation",
      source: "global",
      directory: "bundle/vendors/alpha",
      state: "inherit",
    });
    expect(skillStates(result.body).alpha).toEqual([false, "-", null]);
  });

  test("rejects an unknown skill or state", async () => {
    const bad = await post("/admin/api/skills/toggle", {
      conversationId: CONVERSATION_ID,
      scope: "global",
      source: "global",
      directory: "missing",
      state: "unload",
    });
    expect(bad.status).toBe(404);
    const invalid = await post("/admin/api/skills/toggle", {
      conversationId: CONVERSATION_ID,
      scope: "global",
      source: "global",
      directory: "beta",
      state: "inherit",
    });
    expect(invalid.status).toBe(400);
  });
});
