import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  defaultExtensionDirs,
  extensionSlug,
  ExtensionRegistry,
  listInstalledExtensions,
  loadExtensions,
  parseCommandInput,
  validateExtension,
  type ExtensionCallbackScheduleSpec,
  type ExtensionCallbackScheduleStore,
  type ExtensionSchedulePayload,
  type ExtensionScheduleStore,
} from "../harness/index.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { createOfficeAddress, officeKey } from "../office/index.js";

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
  address: createOfficeAddress("slack", "C123"),
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
  test("returns host-only global then per-office code dirs under the state dir", () => {
    const address = createOfficeAddress("slack", "C123");
    expect(defaultExtensionDirs(address, "/state")).toEqual([
      join("/state", "global", "extensions"),
      join("/state", "conversations", officeKey(address), "extensions"),
    ]);
  });

  test("separates platforms sharing a raw conversation id", () => {
    const [, discordDir] = defaultExtensionDirs(createOfficeAddress("discord", "900100"), "/state");
    const [, telegramDir] = defaultExtensionDirs(
      createOfficeAddress("telegram", "900100"),
      "/state",
    );
    expect(discordDir).not.toBe(telegramDir);
  });

  test("defaults the state dir to ~/.mikan", () => {
    const [globalDir] = defaultExtensionDirs(createOfficeAddress("slack", "C123"));
    expect(globalDir.endsWith(join(".mikan", "global", "extensions"))).toBe(true);
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

  test("a failed activation leaves no partial registrations behind", async () => {
    // activate() registers a hook, a tool, a command, and a disposer, then
    // throws. The shared registry must not keep any of it — and the disposer
    // must run so resources acquired before the throw are released.
    const extDir = join(dir, "half-dead");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "index.mjs"),
      `export const name = "half-dead";
      export function activate(api) {
        globalThis.halfDeadDisposed = false;
        api.on("tool_call", () => ({ block: true }));
        api.registerTool({ name: "half_tool", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
        api.registerCommand({ name: "halfcmd", description: "d", handler: async () => {} });
        api.onDispose(() => { globalThis.halfDeadDisposed = true; });
        throw new Error("activation exploded");
      }
      `,
    );

    const { registry, extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(extensions).toHaveLength(0);
    expect(errors[0]?.error).toContain("activation exploded");
    expect(registry.hasHandlers("tool_call")).toBe(false);
    expect(registry.getContributedTools()).toHaveLength(0);
    expect(registry.getCommands()).toHaveLength(0);
    expect((globalThis as Record<string, unknown>).halfDeadDisposed).toBe(true);
    delete (globalThis as Record<string, unknown>).halfDeadDisposed;
  });

  test("a duplicate tool name is rejected, first registration wins", async () => {
    for (const [slug, toolName] of [
      ["first-owner", "shared_tool"],
      ["second-owner", "shared_tool"],
    ] as const) {
      const extDir = join(dir, slug);
      mkdirSync(extDir, { recursive: true });
      writeFileSync(
        join(extDir, "index.mjs"),
        `export const name = ${JSON.stringify(slug)};
        export function activate(api) {
          api.registerTool({ name: ${JSON.stringify(toolName)}, description: ${JSON.stringify(slug)}, parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
        }
        `,
      );
    }

    const { registry, extensions } = await loadExtensions({ dirs: [dir], context });
    expect(extensions).toHaveLength(2);
    const tools = registry.getContributedTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.description).toBe("first-owner");
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
  test("directory-form extensions slug from the root directory name", () => {
    expect(extensionSlug("/x/extensions/global/Agent PM")).toBe("agent-pm");
    expect(extensionSlug("/x/extensions/global/agent-pm")).toBe("agent-pm");
    // A package.json-form extension's entrypoint may live under dist/; the
    // slug keys off the root, so nesting never splits the identity.
    expect(extensionSlug("/x/extensions/global/agent-pm")).not.toBe("dist");
  });

  test("file-form extensions slug from the file basename", () => {
    expect(extensionSlug("/x/extensions/global/Audit Log.mjs")).toBe("audit-log");
  });
});

describe("TypeScript & manifest extensions", () => {
  test("loads a TypeScript extension via jiti", async () => {
    const extDir = join(dir, "typed");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "index.ts"),
      `interface Api { registerTool(t: unknown): void }
      export default function activate(api: Api): void {
        api.registerTool({ name: "typed_tool", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });
      }`,
    );

    const { registry, extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    expect(extensions[0]?.slug).toBe("typed");
    expect(registry.getContributedTools().map((tool) => tool.name)).toEqual(["typed_tool"]);
  });

  test("package.json declares entrypoint + metadata; slug from dir name", async () => {
    const extDir = join(dir, "my-ext");
    mkdirSync(join(extDir, "src"), { recursive: true });
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({
        name: "my-ext",
        version: "1.0",
        description: "a package",
        mikan: { extensions: ["./src/main.ts"] },
      }),
    );
    writeFileSync(join(extDir, "src", "main.ts"), "export default function activate(): void {}");

    const { extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    // Metadata comes from package.json; slug from the root dir, not the nested entrypoint.
    expect(extensions[0]).toMatchObject({
      slug: "my-ext",
      name: "my-ext",
      version: "1.0",
      description: "a package",
    });
    expect(extensions[0]?.path.endsWith(join("src", "main.ts"))).toBe(true);
  });

  test("mikan.displayName overrides the npm name for the label", async () => {
    const extDir = join(dir, "probe-ext");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({
        name: "@scope/probe",
        version: "2.0",
        mikan: { displayName: "探針 Probe" },
      }),
    );
    writeFileSync(join(extDir, "index.mjs"), "export default function activate() {}");

    const { extensions } = await loadExtensions({ dirs: [dir], context });
    expect(extensions[0]).toMatchObject({ slug: "probe-ext", name: "探針 Probe", version: "2.0" });
  });

  test("manifest.json is a fallback when there is no package.json", async () => {
    const extDir = join(dir, "legacy");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "index.mjs"), "export default function activate() {}");
    writeFileSync(
      join(extDir, "manifest.json"),
      JSON.stringify({ name: "Legacy", version: "0.9", description: "old style" }),
    );

    const { extensions } = await loadExtensions({ dirs: [dir], context });
    expect(extensions[0]).toMatchObject({
      name: "Legacy",
      version: "0.9",
      description: "old style",
    });
  });
});

describe("validateExtension", () => {
  test("passes a well-formed directory extension without activating it", async () => {
    const extDir = join(dir, "good");
    mkdirSync(extDir, { recursive: true });
    // Activation would throw; validate must not call it.
    writeFileSync(
      join(extDir, "index.mjs"),
      'export default function activate() { throw new Error("activated!"); }',
    );
    writeFileSync(join(extDir, "manifest.json"), JSON.stringify({ name: "Good", version: "2.0" }));

    const result = await validateExtension(extDir);
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ slug: "good", name: "Good", version: "2.0" });
    expect(result.entrypoint?.endsWith("index.mjs")).toBe(true);
  });

  test("fails when there is no activate export", async () => {
    const extDir = join(dir, "no-activate");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "index.mjs"), "export const nothing = 1;");

    const result = await validateExtension(extDir);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/activate function/);
  });

  test("fails when the path has no entrypoint", async () => {
    const extDir = join(dir, "empty");
    mkdirSync(extDir, { recursive: true });

    const result = await validateExtension(extDir);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/No entrypoint/);
  });

  test("reports declared requires and warns on unknown capability names", async () => {
    const extDir = join(dir, "needy");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "index.mjs"), "export default function activate() {}");
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({
        name: "needy",
        mikan: { requires: ["messaging", "schedules.telepathy"] },
      }),
    );

    const result = await validateExtension(extDir);
    // Unknown names warn at validate time (the capability may exist in a
    // newer mikan); activation is where they hard-fail.
    expect(result.ok).toBe(true);
    expect(result.requires).toEqual(["messaging", "schedules.telepathy"]);
    expect(result.warnings.join(" ")).toContain("schedules.telepathy");
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

function createFakeCallbackScheduleStore() {
  const entries = new Map<string, ExtensionCallbackScheduleSpec>();
  const store: ExtensionCallbackScheduleStore = {
    upsert: async (slug, name, spec) => {
      entries.set(`${slug}\n${name}`, spec);
    },
    delete: async (slug, name) => entries.delete(`${slug}\n${name}`),
    list: async (slug) =>
      [...entries.entries()]
        .filter(([key]) => key.startsWith(`${slug}\n`))
        .map(([key, spec]) => ({ name: key.split("\n")[1]!, spec })),
  };
  return { entries, store };
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
    // Per-conversation data lives under the conversation; shared under global.
    expect(dataDir).toBe(
      join(
        dir,
        "state",
        "conversations",
        officeKey(createOfficeAddress("slack", "C123")),
        "extension-data",
        "probe",
      ),
    );
    expect(sharedDataDir).toBe(join(dir, "state", "global", "extension-data", "probe"));
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
      platform: "slack",
      conversationId: "C123",
      text: "review overdue follow-ups",
      schedule: "0 9 * * *",
      timezone: "Asia/Taipei",
    });
    expect(probe.read()).toEqual({ names: ["daily-sweep", "kickoff"], deleted: true });
    expect(files.has("ext.probe.c123.kickoff.json")).toBe(false);
  });

  test("mikan.secrets declarations surface in discovery and validation", async () => {
    const { extDir } = writeProbeExtension("export default function activate() {}");
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({
        name: "probe",
        version: "1.0.0",
        mikan: {
          secrets: [
            { key: "SLACK_BOT_TOKEN", description: "standup reads", required: true },
            { key: "OPENAI_API_KEY" },
            { key: "not a key!" },
            "garbage",
          ],
        },
      }),
    );

    const expected = [
      { key: "SLACK_BOT_TOKEN", description: "standup reads", required: true },
      { key: "OPENAI_API_KEY" },
    ];
    const [installed] = listInstalledExtensions([dir]);
    expect(installed?.secrets).toEqual(expected);
    const validation = await validateExtension(extDir);
    expect(validation.secrets).toEqual(expected);
  });

  test("a missing required secret fails activation with a provisioning hint", async () => {
    const { extDir, out } = writeProbeExtension(
      "export default function activate() { report({ activated: true }); }",
    );
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({
        name: "probe",
        mikan: {
          secrets: [
            { key: "SLACK_BOT_TOKEN", required: true },
            { key: "OPENAI_API_KEY", required: false },
          ],
        },
      }),
    );

    const denied = await loadExtensions({
      dirs: [dir],
      context,
      services: { resolveSecrets: () => ({}) },
    });
    expect(denied.extensions).toHaveLength(0);
    expect(denied.errors).toHaveLength(1);
    expect(denied.errors[0]?.error).toContain("SLACK_BOT_TOKEN");
    expect(denied.errors[0]?.error).toContain("vaults/extensions/probe/env");
    expect(denied.errors[0]?.error).not.toContain("OPENAI_API_KEY");
    expect(existsSync(out)).toBe(false);

    const granted = await loadExtensions({
      dirs: [dir],
      context,
      services: { resolveSecrets: () => ({ SLACK_BOT_TOKEN: "xoxb-1" }) },
    });
    expect(granted.errors).toHaveLength(0);
    expect(granted.extensions).toHaveLength(1);
  });

  test("required secrets are not enforced when the context resolves no secrets", async () => {
    const { extDir } = writeProbeExtension("export default function activate() {}");
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({ name: "probe", mikan: { secrets: [{ key: "TOKEN", required: true }] } }),
    );

    const { extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    expect(extensions).toHaveLength(1);
  });

  test("an unmet mikan.requires capability fails activation before import", async () => {
    const { extDir, out } = writeProbeExtension(
      "export default function activate() { report({ activated: true }); }",
    );
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({ name: "probe", mikan: { requires: ["schedules.callback", "messaging"] } }),
    );

    // No services: neither capability is provided.
    const denied = await loadExtensions({ dirs: [dir], context });
    expect(denied.extensions).toHaveLength(0);
    expect(denied.errors).toHaveLength(1);
    expect(denied.errors[0]?.error).toContain("schedules.callback");
    expect(denied.errors[0]?.error).toContain("messaging");
    // The module was never imported — top-level code did not run.
    expect(existsSync(out)).toBe(false);

    const granted = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        callbackScheduleStore: createFakeCallbackScheduleStore().store,
        postMessage: async () => "ts",
      },
    });
    expect(granted.errors).toHaveLength(0);
    expect(granted.extensions).toHaveLength(1);
  });

  test("an unknown mikan.requires name fails activation and is named", async () => {
    const { extDir, out } = writeProbeExtension(
      "export default function activate() { report({ activated: true }); }",
    );
    writeFileSync(
      join(extDir, "package.json"),
      JSON.stringify({ name: "probe", mikan: { requires: ["schedules.telepathy"] } }),
    );

    const { extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(extensions).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("unknown capability");
    expect(errors[0]?.error).toContain("schedules.telepathy");
    expect(existsSync(out)).toBe(false);
  });

  test("api.capabilities reflects the injected services", async () => {
    const probe = writeProbeExtension(
      `export default function activate(api) {
        report({
          messaging: api.capabilities.has("messaging"),
          blockkit: api.capabilities.has("blockkit"),
          list: api.capabilities.list(),
        });
      }`,
    );

    await loadExtensions({
      dirs: [dir],
      context,
      services: { postMessage: async () => "ts" },
    });
    expect(probe.read()).toEqual({ messaging: true, blockkit: false, list: ["messaging"] });
  });

  test("callback schedules route to the callback store and share one name namespace", async () => {
    const { files, store } = createFakeScheduleStore();
    const { entries, store: callbackStore } = createFakeCallbackScheduleStore();
    const probe = writeProbeExtension(
      `export default async function activate(api) {
        await api.schedules.upsert("sweep", {
          type: "periodic",
          schedule: "30 9 * * *",
          timezone: "Asia/Taipei",
          callback: "process-boards",
          args: { boardId: 7 },
        });
        const afterCallback = await api.schedules.list();
        // Re-upserting the same name as a text schedule switches its kind.
        await api.schedules.upsert("sweep", {
          type: "periodic",
          schedule: "0 10 * * *",
          timezone: "Asia/Taipei",
          text: "sweep as agent run",
        });
        const afterText = await api.schedules.list();
        const deleted = await api.schedules.delete("sweep");
        const afterDelete = await api.schedules.list();
        report({
          afterCallback,
          afterTextNames: afterText.map((info) => info.name),
          deleted,
          afterDeleteCount: afterDelete.length,
        });
      }`,
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: { scheduleStore: store, callbackScheduleStore: callbackStore },
    });
    expect(errors).toHaveLength(0);

    const result = probe.read() as {
      afterCallback: Array<{ name: string; spec: object }>;
      afterTextNames: string[];
      deleted: boolean;
      afterDeleteCount: number;
    };
    expect(result.afterCallback).toEqual([
      {
        name: "sweep",
        spec: {
          type: "periodic",
          schedule: "30 9 * * *",
          timezone: "Asia/Taipei",
          callback: "process-boards",
          args: { boardId: 7 },
        },
      },
    ]);
    // After the text upsert the callback entry is gone and the event file exists.
    expect(result.afterTextNames).toEqual(["sweep"]);
    expect(result.deleted).toBe(true);
    expect(result.afterDeleteCount).toBe(0);
    expect(entries.size).toBe(0);
    expect(files.size).toBe(0);
  });

  test("schedule callbacks register per slug and dispatch through the registry", async () => {
    const { store: callbackStore } = createFakeCallbackScheduleStore();
    const probe = writeProbeExtension(
      `export default function activate(api) {
        api.schedules.onCallback("process-boards", (event) => {
          report({ scheduleName: event.scheduleName, args: event.args });
        });
      }`,
    );

    const { registry, errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: { callbackScheduleStore: callbackStore },
    });
    expect(errors).toHaveLength(0);

    const consumed = await registry.dispatchScheduleCallback("probe", "process-boards", {
      scheduleName: "sweep",
      args: { boardId: 7 },
    });
    expect(consumed).toBe(true);
    expect(probe.read()).toEqual({ scheduleName: "sweep", args: { boardId: 7 } });

    const unknown = await registry.dispatchScheduleCallback("probe", "missing", {
      scheduleName: "sweep",
    });
    expect(unknown).toBe(false);
  });

  test("invalid schedule callback names fail that extension's activation", async () => {
    writeProbeExtension(
      `export default function activate(api) {
        api.schedules.onCallback("bad name!", () => {});
      }`,
    );

    const { errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Invalid schedule callback name");
  });

  test("callback specs surface an informative error without a callback store", async () => {
    const probe = writeProbeExtension(
      `export default async function activate(api) {
        try {
          await api.schedules.upsert("sweep", {
            type: "one-shot",
            at: "2099-01-01T00:00:00Z",
            callback: "cb",
          });
        } catch (err) {
          report({ error: String(err) });
        }
      }`,
    );

    const { errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    expect((probe.read() as { error: string }).error).toMatch(/callback-schedule store/);
  });

  test("api.notify posts to the extension's conversation and returns the message id", async () => {
    const posts: Array<{ conversationId: string; text: string }> = [];
    const probe = writeProbeExtension(
      `export default async function activate(api) {
        const ts = await api.notify("hello there");
        report({ ts });
      }`,
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        postMessage: async (conversationId, text) => {
          posts.push({ conversationId, text });
          return "1700000000.9";
        },
      },
    });
    expect(errors).toHaveLength(0);
    expect(posts).toEqual([{ conversationId: "C123", text: "hello there" }]);
    // The id is what makes a posted message addressable afterwards: it is the
    // thread anchor for fetchHistory({ threadTs }) and the target for react.
    expect(probe.read()).toEqual({ ts: "1700000000.9" });
  });

  test("api.react adds a reaction to a message in the extension's conversation", async () => {
    const reactions: Array<{ conversationId: string; messageTs: string; emoji: string }> = [];
    writeProbeExtension(
      'export default async function activate(api) { await api.react("1700000000.1", "eyes"); }',
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        addReaction: async (conversationId, messageTs, emoji) => {
          reactions.push({ conversationId, messageTs, emoji });
        },
      },
    });
    expect(errors).toHaveLength(0);
    expect(reactions).toEqual([
      { conversationId: "C123", messageTs: "1700000000.1", emoji: "eyes" },
    ]);
  });

  test("service-less contexts surface informative errors for schedules, notify, react, upload", async () => {
    const probe = writeProbeExtension(
      `export default async function activate(api) {
        const caught = [];
        try { await api.schedules.upsert("x", { type: "one-shot", at: "2026-01-01T00:00:00Z", text: "t" }); }
        catch (err) { caught.push(String(err)); }
        try { await api.notify("x"); }
        catch (err) { caught.push(String(err)); }
        try { await api.react("1700000000.1", "eyes"); }
        catch (err) { caught.push(String(err)); }
        try { await api.uploadFile("/tmp/report.txt"); }
        catch (err) { caught.push(String(err)); }
        try { await api.triggerRun("go"); }
        catch (err) { caught.push(String(err)); }
        report({ caught });
      }`,
    );

    const { errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    const { caught } = probe.read() as { caught: string[] };
    expect(caught[0]).toMatch(/schedule store/);
    expect(caught[1]).toMatch(/platform messaging/);
    expect(caught[2]).toMatch(/reaction support/);
    expect(caught[3]).toMatch(/file uploads/);
    expect(caught[4]).toMatch(/schedule store/);
  });

  test("api.notify can target another conversation explicitly", async () => {
    const posts: Array<{ conversationId: string; text: string }> = [];
    writeProbeExtension(
      `export default async function activate(api) {
        await api.notify("here");
        await api.notify("there", { conversationId: "C999" });
      }`,
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        postMessage: async (conversationId, text) => {
          posts.push({ conversationId, text });
          return "1700000000.1";
        },
      },
    });
    expect(errors).toHaveLength(0);
    expect(posts).toEqual([
      { conversationId: "C123", text: "here" },
      { conversationId: "C999", text: "there" },
    ]);
  });

  test("api.notify defaults the platform to the conversation's own and forwards threadTs", async () => {
    const posts: Array<{
      conversationId: string;
      text: string;
      platform?: string;
      threadTs?: string;
    }> = [];
    writeProbeExtension(
      `export default async function activate(api) {
        await api.notify("top level");
        await api.notify("threaded", { threadTs: "1700000000.1" });
        await api.notify("elsewhere", { conversationId: "T42", platform: "telegram" });
      }`,
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        postMessage: async (conversationId, text, options) => {
          posts.push({ conversationId, text, platform: options?.platform, ...options });
          return "1700000000.1";
        },
      },
    });
    expect(errors).toHaveLength(0);
    expect(posts).toEqual([
      { conversationId: "C123", text: "top level", platform: "slack" },
      { conversationId: "C123", text: "threaded", platform: "slack", threadTs: "1700000000.1" },
      { conversationId: "T42", text: "elsewhere", platform: "telegram" },
    ]);
  });

  test("api.openDm resolves a DM conversation id on the extension's platform", async () => {
    const opened: Array<{ userId: string; platform?: string }> = [];
    const probe = writeProbeExtension(
      `export default async function activate(api) {
        const dm = await api.openDm("U777");
        report({ dm });
      }`,
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        openDirectConversation: async (userId, platform) => {
          opened.push({ userId, platform });
          return "D555";
        },
      },
    });
    expect(errors).toHaveLength(0);
    expect(opened).toEqual([{ userId: "U777", platform: "slack" }]);
    expect(probe.read()).toEqual({ dm: "D555" });
  });

  test("api.fetchHistory reads this conversation by default, other conversations and threads explicitly", async () => {
    const fetches: Array<{ conversationId: string; options?: object }> = [];
    const probe = writeProbeExtension(
      `export default async function activate(api) {
        const own = await api.fetchHistory({ oldest: "1699.0", limit: 50 });
        const other = await api.fetchHistory({ conversationId: "C999" });
        // The reply loop reads the thread under a message it posted earlier.
        const replies = await api.fetchHistory({ threadTs: "1700000000.5" });
        report({ own: own.length, other: other.length, replies: replies.length });
      }`,
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        fetchHistory: async (conversationId, options) => {
          fetches.push({ conversationId, options });
          return [{ ts: "1700.1", text: "hi", isBot: false }];
        },
      },
    });
    expect(errors).toHaveLength(0);
    expect(fetches).toEqual([
      { conversationId: "C123", options: { oldest: "1699.0", limit: 50, platform: "slack" } },
      { conversationId: "C999", options: { platform: "slack" } },
      { conversationId: "C123", options: { threadTs: "1700000000.5", platform: "slack" } },
    ]);
    expect(probe.read()).toEqual({ own: 1, other: 1, replies: 1 });
  });

  test("api.listUsers lists the extension platform's users", async () => {
    const probe = writeProbeExtension(
      `export default async function activate(api) {
        const users = await api.listUsers();
        report({ ids: users.map((user) => user.id) });
      }`,
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        listUsers: async (platform) => [
          { id: `${platform}-U1`, userName: "ada", displayName: "Ada", isBot: false },
        ],
      },
    });
    expect(errors).toHaveLength(0);
    expect(probe.read()).toEqual({ ids: ["slack-U1"] });
  });

  test("service-less contexts surface informative errors for openDm, fetchHistory, listUsers", async () => {
    const probe = writeProbeExtension(
      `export default async function activate(api) {
        const caught = [];
        try { await api.openDm("U1"); } catch (err) { caught.push(String(err)); }
        try { await api.fetchHistory(); } catch (err) { caught.push(String(err)); }
        try { await api.listUsers(); } catch (err) { caught.push(String(err)); }
        report({ caught });
      }`,
    );

    const { errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    const { caught } = probe.read() as { caught: string[] };
    expect(caught[0]).toMatch(/DM resolution/);
    expect(caught[1]).toMatch(/history reads/);
    expect(caught[2]).toMatch(/user listings/);
  });

  test("api.uploadFile sends a host file into the extension's conversation", async () => {
    const uploads: Array<{ conversationId: string; filePath: string; title?: string }> = [];
    writeProbeExtension(
      'export default async function activate(api) { await api.uploadFile("/tmp/report.pdf", "Weekly"); }',
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        uploadFile: async (conversationId, filePath, title) => {
          uploads.push({ conversationId, filePath, title });
        },
      },
    });
    expect(errors).toHaveLength(0);
    expect(uploads).toEqual([
      { conversationId: "C123", filePath: "/tmp/report.pdf", title: "Weekly" },
    ]);
  });

  test("api.subagent.run delegates to the host runner with contributed tools", async () => {
    const contributedToolNames: string[][] = [];
    const probe = writeProbeExtension(
      `export default async function activate(api) {
        api.registerTool({
          name: "extension_probe",
          description: "probe",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [] }),
        });
        const result = await api.subagent.run({ task: "inspect the probe", tools: ["extension_probe"] });
        report({ status: result.status, runId: result.runId });
      }`,
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: {
        runSubagent: async (_request, contributedTools) => {
          contributedToolNames.push(contributedTools.map((tool) => tool.name));
          return {
            runId: "subagent-1",
            status: "failed",
            model: { provider: "test", id: "test-model" },
            turns: 1,
            usage: {
              input: 10,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 10,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            tokens: 10,
            costUsd: 0,
            durationMs: 5,
            error: "fake subagent failure",
          };
        },
      },
    });

    expect(errors).toHaveLength(0);
    expect(contributedToolNames).toEqual([["extension_probe"]]);
    expect(probe.read()).toEqual({ status: "failed", runId: "subagent-1" });
  });

  test("api.subagent.run reports an unavailable host runner clearly", async () => {
    writeProbeExtension(
      `export default async function activate(api) {
        await api.subagent.run({ task: "cannot run" });
      }`,
    );

    const { extensions, errors } = await loadExtensions({ dirs: [dir], context });

    expect(extensions).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("api.subagent is unavailable");
  });

  test("api.triggerRun writes an immediate event outside the schedules namespace", async () => {
    const { files, store } = createFakeScheduleStore();
    const probe = writeProbeExtension(
      `export default async function activate(api) {
        await api.triggerRun("check the deploy now");
        const listed = await api.schedules.list();
        report({ scheduleNames: listed.map((info) => info.name) });
      }`,
    );

    const { errors } = await loadExtensions({
      dirs: [dir],
      context,
      services: { scheduleStore: store },
    });
    expect(errors).toHaveLength(0);

    const runFiles = [...files.keys()].filter((name) => name.startsWith("extrun.probe.c123."));
    expect(runFiles).toHaveLength(1);
    expect(files.get(runFiles[0])).toEqual({
      type: "immediate",
      platform: "slack",
      conversationId: "C123",
      text: "check the deploy now",
    });
    // Run files must not leak into the extension's schedule inventory.
    expect(probe.read()).toEqual({ scheduleNames: [] });
  });

  test("disposers from onDispose and the activate return value run LIFO on dispose", async () => {
    const probe = writeProbeExtension(
      `const order = [];
      export default function activate(api) {
        api.onDispose(() => { order.push("onDispose"); report({ order }); });
        return () => { order.push("returned"); };
      }`,
    );

    const result = await loadExtensions({ dirs: [dir], context });
    expect(result.errors).toHaveLength(0);
    await result.dispose();
    // The activate-returned disposer registered last, so it runs first.
    expect(probe.read()).toEqual({ order: ["returned", "onDispose"] });
  });

  test("api.registerCommand dispatches with args and user identity", async () => {
    writeProbeExtension(
      `export default function activate(api) {
        api.registerCommand({
          name: "PM",
          description: "follow-up board",
          handler: async ({ args, userId, respond }) => {
            await respond("pm(" + args + ") for " + userId);
          },
        });
      }`,
    );

    const { registry, errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);
    expect(registry.getCommands().map((command) => command.name)).toEqual(["PM"]);

    const replies: string[] = [];
    // Matching is case-insensitive: /pm reaches the command registered as PM.
    const handled = await registry.dispatchCommand("pm", {
      args: "list open",
      conversationId: "C123",
      userId: "U1",
      respond: async (text) => {
        replies.push(text);
      },
    });
    expect(handled).toBe(true);
    expect(replies).toEqual(["pm(list open) for U1"]);

    const unknown = await registry.dispatchCommand("nope", {
      args: "",
      conversationId: "C123",
      respond: async () => {},
    });
    expect(unknown).toBe(false);
  });

  test("a failing command handler is consumed and reports the failure", async () => {
    writeProbeExtension(
      `export default function activate(api) {
        api.registerCommand({ name: "boom", handler: () => { throw new Error("kaput"); } });
      }`,
    );

    const { registry, errors } = await loadExtensions({ dirs: [dir], context });
    expect(errors).toHaveLength(0);

    const replies: string[] = [];
    const handled = await registry.dispatchCommand("boom", {
      args: "",
      conversationId: "C123",
      respond: async (text) => {
        replies.push(text);
      },
    });
    expect(handled).toBe(true);
    expect(replies[0]).toMatch(/\/boom failed: kaput/);
  });

  test("an invalid command name fails that extension's activation", async () => {
    writeProbeExtension(
      `export default function activate(api) {
        api.registerCommand({ name: "no spaces", handler: () => {} });
      }`,
    );

    const { extensions, errors } = await loadExtensions({ dirs: [dir], context });
    expect(extensions).toHaveLength(0);
    expect(errors[0]?.error).toMatch(/Invalid extension command name/);
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

describe("parseCommandInput", () => {
  test("splits a slash command into name and args", () => {
    expect(parseCommandInput("/pm status")).toEqual({ name: "pm", args: "status" });
    expect(parseCommandInput("  /pm  list open  ")).toEqual({ name: "pm", args: "list open" });
    expect(parseCommandInput("/pm")).toEqual({ name: "pm", args: "" });
    expect(parseCommandInput("/pm\nrun\nsweep")).toEqual({ name: "pm", args: "run\nsweep" });
  });

  test("without bareName, unslashed text is not a command", () => {
    expect(parseCommandInput("pm status")).toBeUndefined();
    expect(parseCommandInput("what is still open?")).toBeUndefined();
    expect(parseCommandInput("hello")).toBeUndefined();
  });

  test("bareName accepts the name with or without the slash", () => {
    expect(parseCommandInput("pm status", { bareName: true })).toEqual({
      name: "pm",
      args: "status",
    });
    expect(parseCommandInput("/pm status", { bareName: true })).toEqual({
      name: "pm",
      args: "status",
    });
  });

  test("a first word that cannot be a command name is rejected in both modes", () => {
    for (const text of ["把 task 12 關掉", "* bullet", "…", "", "  "]) {
      expect(parseCommandInput(text)).toBeUndefined();
      expect(parseCommandInput(text, { bareName: true })).toBeUndefined();
    }
  });

  test("bareName still yields a name for unregistered words — dispatch decides", async () => {
    // The parse is deliberately loose: any name-shaped first word parses, and
    // the registry declining it is what sends the text on to the agent. This
    // is the whole of the false-positive story for bare matching.
    expect(parseCommandInput("what is still open?", { bareName: true })).toEqual({
      name: "what",
      args: "is still open?",
    });

    const registry = new ExtensionRegistry();
    registry.registerCommand("probe", { name: "pm", handler: async () => {} });
    const handled = await registry.dispatchCommand("what", {
      args: "is still open?",
      conversationId: "C1",
      respond: async () => {},
    });
    expect(handled).toBe(false);
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

  test("duplicate command names keep the first registration", async () => {
    const registry = new ExtensionRegistry();
    const replies: string[] = [];
    registry.registerCommand("ext-a", {
      name: "pm",
      handler: async ({ respond }) => respond("from a"),
    });
    registry.registerCommand("ext-b", {
      name: "PM",
      handler: async ({ respond }) => respond("from b"),
    });

    await registry.dispatchCommand("pm", {
      args: "",
      conversationId: "C1",
      respond: async (text) => {
        replies.push(text);
      },
    });
    expect(replies).toEqual(["from a"]);
  });

  test("dispose is idempotent and isolates disposer failures", async () => {
    const registry = new ExtensionRegistry();
    const ran: string[] = [];
    registry.registerDisposer("bad", () => {
      ran.push("bad");
      throw new Error("broken disposer");
    });
    registry.registerDisposer("good", () => {
      ran.push("good");
    });

    await registry.dispose();
    // LIFO order, and the bad disposer's error does not stop the run.
    expect(ran).toEqual(["good", "bad"]);

    await registry.dispose();
    expect(ran).toEqual(["good", "bad"]);
  });
});

describe("ExtensionRegistry.emitBeforeAgentStart", () => {
  const event = { prompt: "hi", systemPrompt: "base" };

  test("returns undefined when no handler changes anything", async () => {
    const registry = new ExtensionRegistry();
    registry.register("observer", "before_agent_start", () => undefined);

    expect(await registry.emitBeforeAgentStart({ ...event })).toBeUndefined();
  });

  test("systemPrompt and prompt rewrites chain across handlers", async () => {
    const registry = new ExtensionRegistry();
    registry.register("first", "before_agent_start", ({ systemPrompt }) => ({
      systemPrompt: `${systemPrompt}+A`,
    }));
    registry.register("second", "before_agent_start", ({ systemPrompt, prompt }) => ({
      systemPrompt: `${systemPrompt}+B`,
      prompt: `${prompt}!`,
    }));

    const result = await registry.emitBeforeAgentStart({ ...event });
    // The second handler saw the first handler's rewrite, not the original.
    expect(result).toEqual({ systemPrompt: "base+A+B", prompt: "hi!" });
  });

  test("a block from any handler wins regardless of registration order", async () => {
    const registry = new ExtensionRegistry();
    registry.register("enricher", "before_agent_start", () => ({ systemPrompt: "rewritten" }));
    registry.register("policy", "before_agent_start", () => ({
      block: true,
      reason: "quota exhausted",
    }));

    const result = await registry.emitBeforeAgentStart({ ...event });
    expect(result?.block).toBe(true);
    expect(result?.reason).toBe("quota exhausted");
  });

  test("the first block's reason is kept", async () => {
    const registry = new ExtensionRegistry();
    registry.register("a", "before_agent_start", () => ({ block: true, reason: "first" }));
    registry.register("b", "before_agent_start", () => ({ block: true, reason: "second" }));

    const result = await registry.emitBeforeAgentStart({ ...event });
    expect(result).toEqual({ block: true, reason: "first" });
  });

  test("handler errors are isolated and later handlers still run", async () => {
    const registry = new ExtensionRegistry();
    registry.register("bad", "before_agent_start", () => {
      throw new Error("broken");
    });
    registry.register("good", "before_agent_start", () => ({ block: true }));

    const result = await registry.emitBeforeAgentStart({ ...event });
    expect(result?.block).toBe(true);
  });
});

describe("ExtensionRegistry.emitContext", () => {
  test("chains call-local mutations and replacements without changing the source transcript", async () => {
    const source: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "canonical" }],
        timestamp: 1,
      },
    ];
    const registry = new ExtensionRegistry();
    registry.register("mutator", "context", ({ messages }) => {
      const message = messages[0];
      if (message.role === "user" && typeof message.content !== "string") {
        const part = message.content[0];
        if (part?.type === "text") part.text += "+mutated";
      }
    });
    registry.register("replacer", "context", ({ messages }) => {
      const message = messages[0];
      if (message.role !== "user" || typeof message.content === "string") return;
      const part = message.content[0];
      if (part?.type !== "text") return;
      return {
        messages: [
          {
            ...message,
            content: [{ ...part, text: `${part.text}+replaced` }],
          },
        ],
      };
    });

    const result = await registry.emitContext({ messages: source });

    expect(JSON.stringify(result)).toContain("canonical+mutated+replaced");
    expect(JSON.stringify(source)).toContain("canonical");
    expect(JSON.stringify(source)).not.toContain("mutated");
  });
});

describe("ExtensionRegistry.emitMessageEnd", () => {
  test("chains same-role message replacements", async () => {
    const registry = new ExtensionRegistry();
    registry.register("first", "message_end", ({ message }) => {
      if (message.role !== "user") return;
      return { message: { ...message, content: "first" } };
    });
    registry.register("second", "message_end", ({ message }) => {
      if (message.role !== "user") return;
      return { message: { ...message, content: `${message.content}+second` } };
    });

    const result = await registry.emitMessageEnd({
      message: { role: "user", content: "original", timestamp: 1 },
    });

    expect(result?.message).toMatchObject({ role: "user", content: "first+second" });
  });
});

describe("ExtensionRegistry.emitToolResult", () => {
  const usage: Usage = {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const event = {
    toolCallId: "t1",
    toolName: "bash",
    args: {},
    content: [{ type: "text" as const, text: "token=s3cret" }],
    details: { steps: ["original"] },
    isError: false,
    usage,
  };

  test("returns undefined when no handler changes anything", async () => {
    const registry = new ExtensionRegistry();
    registry.register("observer", "tool_result", () => undefined);

    expect(await registry.emitToolResult({ ...event })).toBeUndefined();
  });

  test("content rewrites chain so redaction sees upstream rewrites", async () => {
    const registry = new ExtensionRegistry();
    registry.register("annotate", "tool_result", ({ content }) => ({
      content: [...content, { type: "text" as const, text: "note: token=s3cret" }],
    }));
    registry.register("redact", "tool_result", ({ content }) => ({
      content: content.map((part) =>
        part.type === "text" ? { ...part, text: part.text.replaceAll("s3cret", "***") } : part,
      ),
    }));

    const result = await registry.emitToolResult({ ...event });
    // The redactor processed the annotator's output, so both parts are clean.
    expect(result?.content).toEqual([
      { type: "text", text: "token=***" },
      { type: "text", text: "note: token=***" },
    ]);
  });

  test("details and usage rewrites chain alongside content and isError", async () => {
    const registry = new ExtensionRegistry();
    registry.register("first", "tool_result", ({ details, usage: toolUsage }) => ({
      details: { steps: [...(details as { steps: string[] }).steps, "first"] },
      usage: {
        ...toolUsage!,
        output: toolUsage!.output + 1,
        totalTokens: toolUsage!.totalTokens + 1,
      },
    }));
    registry.register("second", "tool_result", ({ details, usage: toolUsage }) => ({
      details: { steps: [...(details as { steps: string[] }).steps, "second"] },
      usage: {
        ...toolUsage!,
        output: toolUsage!.output + 1,
        totalTokens: toolUsage!.totalTokens + 1,
      },
      isError: true,
    }));

    const result = await registry.emitToolResult({ ...event });
    expect(result).toEqual({
      details: { steps: ["original", "first", "second"] },
      usage: { ...usage, output: 4, totalTokens: 5 },
      isError: true,
    });
  });
});
