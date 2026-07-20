import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  assertStateDirOutsideWorkspace,
  conversationSettingsPath,
  createGlobalSettingsFile,
  isPathInside,
  loadGlobalSettings,
  loadSandboxSettings,
  resolveConversationSettings,
  resolveSentryDsn,
  updateConversationSettings,
  updateGlobalSettings,
} from "../src/config.js";

describe("loadGlobalSettings", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mikan-test-${Date.now()}-${Math.random()}`);
    mkdirSync(stateDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    delete process.env.MIKAN_AI_PROVIDER;
    delete process.env.MIKAN_AI_MODEL;
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
  });

  test("throws when global settings.json is missing", () => {
    expect(() => loadGlobalSettings()).toThrow(/Missing global settings file/);
  });

  test("creates onboard settings", () => {
    const settingsPath = createGlobalSettingsFile(stateDir);
    expect(settingsPath).toBe(join(stateDir, "settings.json"));
    const config = loadGlobalSettings();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.thinkingLevel).toBe("off");
    expect(config.sandbox?.cpus).toBe("0.5");
    expect(config.sandbox?.memory).toBe("1g");
    expect(config.sandbox?.boost?.cpus).toBe("2");
    expect(config.sandbox?.boost?.memory).toBe("4g");
    expect(config.sandbox?.image?.workspaceMount).toBe("private");
    expect(config.sandbox?.defaultSharedVault).toBeUndefined();
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).sandbox.defaultSharedVault).toBe("");
  });

  test("loads sandbox settings without requiring agent model fields", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({ sandbox: { cpus: "2", memory: "4g" } }),
    );
    expect(loadSandboxSettings()).toMatchObject({ cpus: "2", memory: "4g" });
  });

  test("reads provider and model from settings.json", () => {
    updateGlobalSettings({ provider: "openai", model: "gpt-4o" });
    const config = loadGlobalSettings();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
  });

  test("reads sentryDsn from settings.json", () => {
    updateGlobalSettings({ sentryDsn: "https://examplePublicKey@o0.ingest.sentry.io/0" });
    const config = loadGlobalSettings();
    expect(config.sentryDsn).toBe("https://examplePublicKey@o0.ingest.sentry.io/0");
  });

  test("reads sandbox cpus, memory, and boost from settings.json", () => {
    updateGlobalSettings({
      sandbox: {
        cpus: "0.5",
        memory: "512m",
        boost: { cpus: "2", memory: "4g" },
      },
    });
    const config = loadGlobalSettings();
    expect(config.sandbox?.cpus).toBe("0.5");
    expect(config.sandbox?.memory).toBe("512m");
    expect(config.sandbox?.boost?.cpus).toBe("2");
    expect(config.sandbox?.boost?.memory).toBe("4g");
  });

  test("sandbox cpus and memory are undefined when omitted from settings", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
      }),
      "utf-8",
    );
    const config = loadGlobalSettings();
    expect(config.sandbox?.cpus).toBeUndefined();
    expect(config.sandbox?.memory).toBeUndefined();
    expect(config.sandbox?.boost?.cpus).toBeUndefined();
    expect(config.sandbox?.boost?.memory).toBeUndefined();
  });

  test("provider and model come from settings.json, not env vars", () => {
    updateGlobalSettings({ provider: "openai", model: "gpt-4o" });
    process.env.MIKAN_AI_PROVIDER = "google";
    process.env.MIKAN_AI_MODEL = "gemini-2.0-flash";

    const config = loadGlobalSettings();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
  });

  test("ignores settings.json in non-state directories", () => {
    const otherDir = join(tmpdir(), `mikan-other-${Date.now()}`);
    mkdirSync(otherDir, { recursive: true });
    try {
      writeFileSync(
        join(otherDir, "settings.json"),
        JSON.stringify({ llm: { provider: "openai", model: "gpt-4o" } }),
        "utf-8",
      );
      createGlobalSettingsFile(stateDir);
      const config = loadGlobalSettings();
      expect(config.provider).toBe("anthropic");
      expect(config.model).toBe("claude-sonnet-4-6");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("throws on malformed settings.json instead of silently falling back", () => {
    writeFileSync(join(stateDir, "settings.json"), "{ invalid json }", "utf-8");
    expect(() => loadGlobalSettings()).toThrow(/Malformed settings file/);
  });

  test("throws on settings.json whose top-level value is not an object", () => {
    writeFileSync(join(stateDir, "settings.json"), "[]", "utf-8");
    expect(() => loadGlobalSettings()).toThrow(/expected a JSON object/);
  });

  test("throws on settings.json with invalid nested field types", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
        sandbox: { cpus: 2 },
      }),
      "utf-8",
    );

    expect(() => loadGlobalSettings()).toThrow(
      /Malformed settings file.*sandbox.*cpus.*Expected string/,
    );
  });

  test("throws on settings.json with invalid thinkingLevel", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "on" },
      }),
      "utf-8",
    );

    expect(() => loadGlobalSettings()).toThrow(
      /Malformed settings file.*thinkingLevel.*Expected union value/,
    );
  });

  test("throws on conversation settings.json with invalid nested field types", () => {
    createGlobalSettingsFile(stateDir);
    const conversationDir = join(stateDir, "workspace", "C123");
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      join(conversationDir, "settings.json"),
      JSON.stringify({ sandbox: { image: { workspaceMount: "everything" } } }),
      "utf-8",
    );

    expect(() => resolveConversationSettings(conversationDir)).toThrow(
      /Malformed settings file.*workspaceMount/,
    );
  });

  test("conversation model config overrides global provider and model only", () => {
    updateGlobalSettings({ provider: "anthropic", model: "claude-sonnet-4-6" });
    const conversationDir = join(stateDir, "workspace", "C123");
    updateConversationSettings(conversationDir, {
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "low",
    });

    const config = resolveConversationSettings(conversationDir);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
    expect(config.thinkingLevel).toBe("low");
    // Settings are host-authoritative: stored under the state dir, never in
    // the (sandbox-mounted) conversation dir.
    expect(existsSync(join(conversationDir, "settings.json"))).toBe(false);
    expect(JSON.parse(readFileSync(conversationSettingsPath(conversationDir), "utf-8"))).toEqual({
      llm: { provider: "openai", model: "gpt-4o", thinkingLevel: "low" },
    });
  });

  test("conversation sandbox config overrides global image workspace mount", () => {
    createGlobalSettingsFile(stateDir);
    const conversationDir = join(stateDir, "workspace", "C123");
    updateConversationSettings(conversationDir, { sandbox: { image: { workspaceMount: "full" } } });

    const config = resolveConversationSettings(conversationDir);
    expect(config.sandbox?.image?.workspaceMount).toBe("full");
    expect(JSON.parse(readFileSync(conversationSettingsPath(conversationDir), "utf-8"))).toEqual({
      sandbox: { image: { workspaceMount: "full" } },
    });
  });

  test("sandbox settings merge at the leaf level across global and conversation", () => {
    createGlobalSettingsFile(stateDir);
    updateGlobalSettings({ sandbox: { cpus: "1", boost: { cpus: "4" } } });
    const conversationDir = join(stateDir, "workspace", "C123");
    updateConversationSettings(conversationDir, {
      sandbox: { memory: "2g", boost: { memory: "8g" } },
    });

    const config = resolveConversationSettings(conversationDir);
    // Global sandbox.cpus survives a conversation that only sets sandbox.memory.
    expect(config.sandbox?.cpus).toBe("1");
    expect(config.sandbox?.memory).toBe("2g");
    // Same invariant one level down: boost merges per leaf too.
    expect(config.sandbox?.boost?.cpus).toBe("4");
    expect(config.sandbox?.boost?.memory).toBe("8g");
  });

  test("conversation slack config overrides global reply mode", () => {
    updateGlobalSettings({ slack: { replyMode: "top-level" } });
    const conversationDir = join(stateDir, "workspace", "C123");
    updateConversationSettings(conversationDir, { slack: { replyMode: "thread" } });

    const config = resolveConversationSettings(conversationDir);
    expect(config.slack?.replyMode).toBe("thread");
    expect(JSON.parse(readFileSync(conversationSettingsPath(conversationDir), "utf-8"))).toEqual({
      slack: { replyMode: "thread" },
    });
  });

  test("migrates a legacy conversation settings.json into the state dir once", () => {
    createGlobalSettingsFile(stateDir);
    const conversationDir = join(stateDir, "workspace", "C123");
    mkdirSync(conversationDir, { recursive: true });
    const legacyPath = join(conversationDir, "settings.json");
    writeFileSync(legacyPath, JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }));

    const config = resolveConversationSettings(conversationDir);
    expect(config.sandbox?.image?.workspaceMount).toBe("full");
    // Legacy file was moved out of the (sandbox-mounted) conversation dir.
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(conversationSettingsPath(conversationDir))).toBe(true);
  });

  test("a legacy settings.json appearing after migration is never read (sandbox plant)", () => {
    createGlobalSettingsFile(stateDir);
    const conversationDir = join(stateDir, "workspace", "C123");
    mkdirSync(conversationDir, { recursive: true });

    // First access with no legacy file writes the migration marker.
    // (Global onboard settings default the mount mode to "private".)
    expect(resolveConversationSettings(conversationDir).sandbox?.image?.workspaceMount).toBe(
      "private",
    );

    // An agent inside the sandbox plants a legacy settings.json afterwards,
    // trying to flip its own mount mode to full. It must stay ignored.
    writeFileSync(
      join(conversationDir, "settings.json"),
      JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }),
    );
    expect(resolveConversationSettings(conversationDir).sandbox?.image?.workspaceMount).toBe(
      "private",
    );
    // And it is not deleted either: only pre-migration files are moved.
    expect(existsSync(join(conversationDir, "settings.json"))).toBe(true);
  });
});

describe("state dir placement guard", () => {
  test("isPathInside is lexical and slash-aware", () => {
    expect(isPathInside("/work/state", "/work")).toBe(true);
    expect(isPathInside("/work", "/work")).toBe(true);
    expect(isPathInside("/work-state", "/work")).toBe(false);
    expect(isPathInside("/elsewhere", "/work")).toBe(false);
  });

  test("throws under sandboxed modes when state dir is inside the working dir", () => {
    expect(() => assertStateDirOutsideWorkspace("/work/.mikan", "/work", "image")).toThrow(
      /must not be inside the working directory/,
    );
    expect(() => assertStateDirOutsideWorkspace("/work/.mikan", "/work", "container")).toThrow();
  });

  test("host mode only warns; disjoint paths always pass", () => {
    expect(() => assertStateDirOutsideWorkspace("/work/.mikan", "/work", "host")).not.toThrow();
    expect(() => assertStateDirOutsideWorkspace("/home/u/.mikan", "/work", "image")).not.toThrow();
  });
});

describe("resolveSentryDsn", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mikan-test-sentry-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    delete process.env.SENTRY_DSN;
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
  });

  test("prefers settings.json over env", () => {
    updateGlobalSettings({ sentryDsn: "https://settings.example/1" });
    process.env.SENTRY_DSN = "https://env.example/1";
    expect(resolveSentryDsn()).toBe("https://settings.example/1");
  });

  test("falls back to env when settings.json has no sentryDsn", () => {
    process.env.SENTRY_DSN = "https://env.example/2";
    expect(resolveSentryDsn()).toBe("https://env.example/2");
  });
});

describe("updateGlobalSettings", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mikan-test-${Date.now()}-${Math.random()}`);
    mkdirSync(stateDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
  });

  test("creates settings.json with given config", () => {
    updateGlobalSettings({ provider: "google", model: "gemini-2.0-flash" });
    const config = loadGlobalSettings();
    expect(config.provider).toBe("google");
    expect(config.model).toBe("gemini-2.0-flash");
    expect(JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf-8"))).toEqual({
      llm: {
        provider: "google",
        model: "gemini-2.0-flash",
        thinkingLevel: "off",
        autoReply: { provider: "anthropic", model: "claude-haiku-4-5" },
      },
      sandbox: {
        cpus: "0.5",
        memory: "1g",
        boost: { cpus: "2", memory: "4g" },
        image: { workspaceMount: "private" },
        defaultSharedVault: "",
      },
      slack: { replyMode: "top-level" },
    });
  });

  test("merges with existing settings — preserves unrelated fields", () => {
    updateGlobalSettings({ provider: "openai", model: "gpt-4o" });
    updateGlobalSettings({ model: "gpt-4o-mini" });
    const config = loadGlobalSettings();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o-mini");
    expect(JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf-8"))).toEqual({
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        thinkingLevel: "off",
        autoReply: { provider: "anthropic", model: "claude-haiku-4-5" },
      },
      sandbox: {
        cpus: "0.5",
        memory: "1g",
        boost: { cpus: "2", memory: "4g" },
        image: { workspaceMount: "private" },
        defaultSharedVault: "",
      },
      slack: { replyMode: "top-level" },
    });
  });

  test("creates parent directories if they don't exist", () => {
    const nested = join(stateDir, "a", "b", "c");
    process.env.MIKAN_STATE_DIR = nested;
    updateGlobalSettings({ provider: "anthropic" });
    expect(existsSync(join(nested, "settings.json"))).toBe(true);
  });

  test("saves global workspace mount and shared vault settings", () => {
    updateGlobalSettings({
      sandbox: { image: { workspaceMount: "full" }, defaultSharedVault: "shared-team" },
    });

    const config = loadGlobalSettings();
    expect(config.sandbox?.image?.workspaceMount).toBe("full");
    expect(config.sandbox?.defaultSharedVault).toBe("shared-team");
    expect(
      JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf-8")).sandbox,
    ).toMatchObject({
      image: { workspaceMount: "full" },
      defaultSharedVault: "shared-team",
    });
  });
});
