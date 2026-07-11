import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  defaultExtensionDirs,
  extensionSlug,
  ExtensionRegistry,
  loadExtensions,
  type ExtensionSchedulePayload,
  type ExtensionScheduleStore,
} from "../src/harness/index.js";
import type { Api, Model } from "@earendil-works/pi-ai";

let dir: string;

const testModel = {
  id: "test-model",
  name: "Test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as Model<Api>;

const context = {
  conversationId: "C123",
  workspaceDir: "/work",
  model: testModel,
  thinkingLevel: "off" as const,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-harness-ext-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("defaultExtensionDirs", () => {
  test("returns host-only global and per-conversation dirs under the state dir", () => {
    expect(defaultExtensionDirs("C123", "/state")).toEqual([
      join("/state", "extensions", "global"),
      join("/state", "extensions", "C123"),
    ]);
  });

  test("defaults the state dir to ~/.mikan", () => {
    const [globalDir] = defaultExtensionDirs("C123");
    expect(globalDir.endsWith(join(".mikan", "extensions", "global"))).toBe(true);
  });
});

describe("loadExtensions", () => {
  test("activates default-export extensions and dispatches hooks", async () => {
    writeFileSync(
      join(dir, "blocker.mjs"),
      `export default function activate(api) {
        api.on("tool_call", ({ toolName }) => {
          if (toolName === "bash") return { block: true, reason: "no shell" };
        });
      }
      `,
    );

    const { registry, extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    expect(extensions).toHaveLength(1);

    const blocked = await registry.emit("tool_call", {
      toolCallId: "t1",
      toolName: "bash",
      args: {},
    });
    expect(blocked).toEqual({ block: true, reason: "no shell" });

    const allowed = await registry.emit("tool_call", {
      toolCallId: "t2",
      toolName: "read",
      args: {},
    });
    expect(allowed).toBeUndefined();
  });

  test("supports named activate exports in index.js directories", async () => {
    const extDir = join(dir, "named");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "index.mjs"),
      `export const name = "named-extension";
      export function activate(api) {
        api.registerTool({ name: "custom_tool", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
      }
      `,
    );

    const { registry, extensions } = await loadExtensions({ dirs: [dir], context });
    expect(extensions[0]?.name).toBe("named-extension");
    expect(registry.getContributedTools().map((tool) => tool.name)).toEqual(["custom_tool"]);
  });

  test("collects module errors without failing the load", async () => {
    writeFileSync(join(dir, "broken.mjs"), "throw new Error('boom');\n");
    writeFileSync(join(dir, "no-activate.mjs"), "export const nothing = 1;\n");

    const { extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(extensions).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  test("an index file at the scan root is skipped with no load error", async () => {
    // Contents copied into the scope dir itself would make the slug
    // degenerate to the scope name (e.g. the conversation id).
    writeFileSync(join(dir, "index.mjs"), "export default function activate() {}\n");

    const { extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(extensions).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  test("missing directories are skipped", async () => {
    const { extensions, errors } = await loadExtensions({
      dirs: [join(dir, "missing")],
      context,
    });
    expect(extensions).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});

describe("extensionSlug", () => {
  test("directory-form extensions slug from the directory name", () => {
    expect(extensionSlug("/x/extensions/global/Agent PM/index.mjs")).toBe("agent-pm");
    expect(extensionSlug("/x/extensions/global/agent-pm/index.js")).toBe("agent-pm");
  });

  test("file-form extensions slug from the file basename", () => {
    expect(extensionSlug("/x/extensions/global/Audit Log.mjs")).toBe("audit-log");
  });
});

function createFakeScheduleStore() {
  const files = new Map<string, ExtensionSchedulePayload>();
  const store: ExtensionScheduleStore = {
    write: async (filename, payload) => {
      files.set(filename, payload);
    },
    delete: async (filename) => files.delete(filename),
    list: async () => [...files.entries()].map(([filename, payload]) => ({ filename, payload })),
  };
  return { files, store };
}

describe("loadExtensions v2 api", () => {
  /**
   * Write a directory-form probe extension whose activate body can report
   * results by writing JSON to the `out` path (lint-safe, no globals).
   */
  function writeProbeExtension(body: string): { extDir: string; out: string; read: () => any } {
    const extDir = join(dir, "probe");
    const out = join(dir, "probe-out.json");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "index.mjs"),
      `import { writeFileSync } from "node:fs";
      const report = (data) => writeFileSync(${JSON.stringify(out)}, JSON.stringify(data));
      ${body}
      `,
    );
    return { extDir, out, read: () => JSON.parse(readFileSync(out, "utf-8")) };
  }

  test("manifest.json provides name, version, and description", async () => {
    const { extDir } = writeProbeExtension("export default function activate() {}");
    writeFileSync(
      join(extDir, "manifest.json"),
      JSON.stringify({ name: "Probe 探針", version: "1.2.3", description: "a probe" }),
    );

    const { extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    expect(extensions[0]).toMatchObject({
      name: "Probe 探針",
      slug: "probe",
      version: "1.2.3",
      description: "a probe",
    });
  });

  test("malformed manifest.json is ignored and the extension still loads", async () => {
    const { extDir } = writeProbeExtension("export default function activate() {}");
    writeFileSync(join(extDir, "manifest.json"), "{not json");

    const { extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    expect(extensions[0]?.name).toBe("probe");
  });

  test("api.paths.dataDir is conversation-scoped; sharedDataDir is the explicit opt-in", async () => {
    const probe = writeProbeExtension(
      "export default function activate(api) { report({ dataDir: api.paths.dataDir, sharedDataDir: api.paths.sharedDataDir }); }",
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: { stateDir: join(dir, "state") },
    });
    expect(errors).toHaveLength(0);
    const { dataDir, sharedDataDir } = probe.read() as { dataDir: string; sharedDataDir: string };
    // Conversation isolation is the default: the safe path gets the short name.
    expect(dataDir).toBe(join(dir, "state", "extension-data", "probe", "conversations", "C123"));
    expect(sharedDataDir).toBe(join(dir, "state", "extension-data", "probe", "shared"));
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(sharedDataDir)).toBe(true);
  });

  test("api.secrets reads from the injected resolver, keyed by slug", async () => {
    const probe = writeProbeExtension(
      `export default function activate(api) {
        report({ token: api.secrets.get("TOKEN"), keys: api.secrets.list() });
      }`,
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        resolveSecrets: (slug) => (slug === "probe" ? { TOKEN: "s3cret", OTHER: "x" } : {}),
      },
    });
    expect(errors).toHaveLength(0);
    expect(probe.read()).toEqual({ token: "s3cret", keys: ["TOKEN", "OTHER"] });
  });

  test("api.schedules scopes files by slug + conversation and round-trips specs", async () => {
    const { files, store } = createFakeScheduleStore();
    // A schedule from another extension/conversation must not leak into list().
    files.set("ext.other.c123.job.json", {
      type: "periodic",
      conversationId: "C123",
      text: "other",
      schedule: "0 9 * * *",
      timezone: "UTC",
    });

    const probe = writeProbeExtension(
      `export default async function activate(api) {
        await api.schedules.upsert("Daily Sweep", {
          type: "periodic",
          schedule: "0 9 * * *",
          timezone: "Asia/Taipei",
          text: "review overdue follow-ups",
        });
        await api.schedules.upsert("kickoff", {
          type: "one-shot",
          at: "2026-08-01T09:00:00+08:00",
          text: "kick off",
        });
        const listed = await api.schedules.list();
        const deleted = await api.schedules.delete("kickoff");
        report({ names: listed.map((info) => info.name).toSorted(), deleted });
      }`,
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: { scheduleStore: store },
    });
    expect(errors).toHaveLength(0);

    expect(files.get("ext.probe.c123.daily-sweep.json")).toEqual({
      type: "periodic",
      conversationId: "C123",
      text: "review overdue follow-ups",
      schedule: "0 9 * * *",
      timezone: "Asia/Taipei",
    });
    expect(probe.read()).toEqual({ names: ["daily-sweep", "kickoff"], deleted: true });
    expect(files.has("ext.probe.c123.kickoff.json")).toBe(false);
  });

  test("api.notify posts to the extension's conversation", async () => {
    const posts: Array<{ conversationId: string; text: string }> = [];
    writeProbeExtension(
      'export default async function activate(api) { await api.notify("hello there"); }',
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        postMessage: async (conversationId, text) => {
          posts.push({ conversationId, text });
        },
      },
    });
    expect(errors).toHaveLength(0);
    expect(posts).toEqual([{ conversationId: "C123", text: "hello there" }]);
  });

  test("service-less contexts surface informative errors for schedules and notify", async () => {
    const probe = writeProbeExtension(
      `export default async function activate(api) {
        const caught = [];
        try { await api.schedules.upsert("x", { type: "one-shot", at: "2026-01-01T00:00:00Z", text: "t" }); }
        catch (err) { caught.push(String(err)); }
        try { await api.notify("x"); }
        catch (err) { caught.push(String(err)); }
        report({ caught });
      }`,
    );

    const { errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    const { caught } = probe.read() as { caught: string[] };
    expect(caught[0]).toMatch(/schedule store/);
    expect(caught[1]).toMatch(/platform messaging/);
  });

  test("skills/ directory contributes inline skills", async () => {
    const { extDir } = writeProbeExtension("export default function activate() {}");
    const skillDir = join(extDir, "skills", "triage");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: triage\ndescription: triage follow-ups\n---\nAlways triage before answering.\n",
    );

    const { skills, extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "triage",
      source: "extension:probe",
      inline: true,
    });
    expect(skills[0].content).toContain("Always triage");
    expect(extensions[0]?.skills).toHaveLength(1);
  });
});

describe("ExtensionRegistry", () => {
  test("handler errors are isolated and later handlers still run", async () => {
    const registry = new ExtensionRegistry();
    registry.register("bad", "tool_call", () => {
      throw new Error("broken handler");
    });
    registry.register("good", "tool_call", () => ({ block: true }));

    const result = await registry.emit("tool_call", { toolCallId: "t", toolName: "x", args: {} });
    expect(result).toEqual({ block: true });
  });

  test("first non-undefined result wins", async () => {
    const registry = new ExtensionRegistry();
    registry.register("first", "tool_call", () => ({ block: false }));
    registry.register("second", "tool_call", () => ({ block: true }));

    const result = await registry.emit("tool_call", { toolCallId: "t", toolName: "x", args: {} });
    expect(result).toEqual({ block: false });
  });
});
