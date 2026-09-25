import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import {
  conversationSettingsPath,
  createGlobalSettingsFile,
  loadGlobalSettings,
  resolveConversationSettings,
  resolveSentryDsn,
  updateConversationSettings,
  updateGlobalSettings,
} from "../settings/index.js";

describe("loadGlobalSettings", () => {
  let stateDir: string;

  function office(): Office {
    return createWorkspace({ root: join(stateDir, "workspace"), stateDir }).office(
      createOfficeAddress("slack", "C123"),
    );
  }

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

  test("ignores retired auto-reply configuration without rewriting existing files", () => {
    const path = join(stateDir, "settings.json");
    const content = JSON.stringify({
      llm: {
        provider: "anthropic",
        model: "main",
        thinkingLevel: "off",
        autoReply: { provider: "retired", model: "judge" },
      },
      autoReply: { enabled: true, rules: ["reply to everything"] },
    });
    writeFileSync(path, content);
    expect(loadGlobalSettings()).toMatchObject({ provider: "anthropic", model: "main" });
    expect(loadGlobalSettings()).not.toHaveProperty("autoReply");
    expect(readFileSync(path, "utf8")).toBe(content);
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
    expect(config.sandbox?.defaultSharedVault).toBeUndefined();
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).sandbox.defaultSharedVault).toBe("");
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
    const conversation = office();
    mkdirSync(conversation.dir, { recursive: true });
    writeFileSync(
      join(conversation.dir, "settings.json"),
      JSON.stringify({ sandbox: { image: { workspaceMount: "everything" } } }),
      "utf-8",
    );

    expect(() => resolveConversationSettings(conversation)).toThrow(
      /Malformed settings file.*workspaceMount/,
    );
  });

  test("conversation model config overrides global provider and model only", () => {
    updateGlobalSettings({ provider: "anthropic", model: "claude-sonnet-4-6" });
    const conversation = office();
    updateConversationSettings(conversation, {
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "low",
    });

    const config = resolveConversationSettings(conversation);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
    expect(config.thinkingLevel).toBe("low");
    expect(existsSync(join(conversation.dir, "settings.json"))).toBe(false);
    expect(JSON.parse(readFileSync(conversationSettingsPath(conversation), "utf-8"))).toEqual({
      llm: { provider: "openai", model: "gpt-4o", thinkingLevel: "low" },
    });
  });

  test("retired door-policy keys load but are dropped from the resolved config", () => {
    createGlobalSettingsFile(stateDir);
    const conversation = office();
    mkdirSync(conversation.stateDir, { recursive: true });
    writeFileSync(
      conversationSettingsPath(conversation),
      JSON.stringify({
        sandbox: { memory: "2g", image: { workspaceMount: "full" }, workspace: { layout: "full" } },
      }),
    );

    const config = resolveConversationSettings(conversation);
    expect(config.sandbox).toEqual({
      cpus: "0.5",
      memory: "2g",
      boost: { cpus: "2", memory: "4g" },
    });
  });

  test("sandbox settings merge at the leaf level across global and conversation", () => {
    createGlobalSettingsFile(stateDir);
    updateGlobalSettings({ sandbox: { cpus: "1", boost: { cpus: "4" } } });
    const conversation = office();
    updateConversationSettings(conversation, {
      sandbox: { memory: "2g", boost: { memory: "8g" } },
    });

    const config = resolveConversationSettings(conversation);
    expect(config.sandbox?.cpus).toBe("1");
    expect(config.sandbox?.memory).toBe("2g");
    expect(config.sandbox?.boost?.cpus).toBe("4");
    expect(config.sandbox?.boost?.memory).toBe("8g");
  });

  test("mcp servers merge per key: conversation overrides or disables one, keeps the rest", () => {
    createGlobalSettingsFile(stateDir);
    updateGlobalSettings({
      mcpServers: {
        github: { command: "npx", args: ["-y", "server-github"], env: { TOKEN: "t" } },
        docs: { url: "https://docs.example/mcp" },
      },
    });
    const conversation = office();
    updateConversationSettings(conversation, {
      mcpServers: {
        github: { command: "npx", args: ["-y", "server-github"], disabled: true },
        local: { command: "./bin/local-mcp" },
      },
    });

    const config = resolveConversationSettings(conversation);
    expect(config.mcpServers?.github?.disabled).toBe(true);
    expect(config.mcpServers?.github?.env).toBeUndefined();
    expect(config.mcpServers?.docs?.url).toBe("https://docs.example/mcp");
    expect(config.mcpServers?.local?.command).toBe("./bin/local-mcp");
  });

  test("conversation slack config overrides global reply mode", () => {
    updateGlobalSettings({ slack: { replyMode: "top-level" } });
    const conversation = office();
    updateConversationSettings(conversation, { slack: { replyMode: "thread" } });

    const config = resolveConversationSettings(conversation);
    expect(config.slack?.replyMode).toBe("thread");
    expect(JSON.parse(readFileSync(conversationSettingsPath(conversation), "utf-8"))).toEqual({
      slack: { replyMode: "thread" },
    });
  });

  test("migrates a legacy conversation settings.json into the state dir once", () => {
    createGlobalSettingsFile(stateDir);
    const conversation = office();
    mkdirSync(conversation.dir, { recursive: true });
    const legacyPath = join(conversation.dir, "settings.json");
    writeFileSync(legacyPath, JSON.stringify({ sandbox: { memory: "3g" } }));

    const config = resolveConversationSettings(conversation);
    expect(config.sandbox?.memory).toBe("3g");
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(conversationSettingsPath(conversation))).toBe(true);
  });

  test("a legacy settings.json appearing after migration is never read (sandbox plant)", () => {
    createGlobalSettingsFile(stateDir);
    const conversation = office();
    mkdirSync(conversation.dir, { recursive: true });

    expect(resolveConversationSettings(conversation).sandbox?.memory).toBe("1g");

    writeFileSync(
      join(conversation.dir, "settings.json"),
      JSON.stringify({ sandbox: { memory: "9g" } }),
    );
    expect(resolveConversationSettings(conversation).sandbox?.memory).toBe("1g");
    expect(existsSync(join(conversation.dir, "settings.json"))).toBe(true);
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
      },
      sandbox: {
        cpus: "0.5",
        memory: "1g",
        boost: { cpus: "2", memory: "4g" },
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
      },
      sandbox: {
        cpus: "0.5",
        memory: "1g",
        boost: { cpus: "2", memory: "4g" },
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

  test("saves global shared vault settings", () => {
    updateGlobalSettings({ sandbox: { defaultSharedVault: "shared-team" } });

    const config = loadGlobalSettings();
    expect(config.sandbox?.defaultSharedVault).toBe("shared-team");
    expect(
      JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf-8")).sandbox,
    ).toMatchObject({ defaultSharedVault: "shared-team" });
  });
});
