import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import {
  conversationSettingsPath,
  createGlobalSettingsFile,
  findUnusedSettings,
  loadGlobalSettings,
  resolveConversationSettings,
  loadGithubSettings,
  updateConversationSettings,
  updateGlobalSettings,
} from "../settings/index.js";

function llmSettings(model: string): string {
  return JSON.stringify({ llm: { provider: "anthropic", model, thinkingLevel: "off" } });
}

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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
    expect(loadGlobalSettings(stateDir)).toMatchObject({ provider: "anthropic", model: "main" });
    expect(loadGlobalSettings(stateDir)).not.toHaveProperty("autoReply");
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  test("finds the settings keys mikan ignores without creating conversation settings", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "main", thinkingLevel: "off", autoReply: {} },
        sandbox: { cpus: "1", image: { workspaceMount: "full" } },
        autoReply: { enabled: true },
      }),
    );
    const configured = office();
    mkdirSync(configured.stateDir, { recursive: true });
    writeFileSync(
      join(configured.stateDir, "settings.json"),
      JSON.stringify({ llm: { model: "other" }, mcpServers: { docs: { url: "x", timeout: 5 } } }),
    );
    const unconfigured = createWorkspace({ root: join(stateDir, "workspace"), stateDir }).office(
      createOfficeAddress("slack", "C456"),
    );

    expect(findUnusedSettings(stateDir, [configured, unconfigured])).toEqual([
      {
        path: join(stateDir, "settings.json"),
        keys: ["llm.autoReply", "sandbox.image", "autoReply"],
      },
      { path: join(configured.stateDir, "settings.json"), keys: ["mcpServers.docs.timeout"] },
    ]);
    expect(existsSync(join(unconfigured.stateDir, "settings.json"))).toBe(false);
  });

  test("conversation settings inherit the global settings of their own workspace, not ~/.mikan", () => {
    const otherStateDir = join(stateDir, "home", ".mikan");
    mkdirSync(otherStateDir, { recursive: true });
    writeFileSync(join(stateDir, "settings.json"), llmSettings("workspace-model"));
    writeFileSync(join(otherStateDir, "settings.json"), llmSettings("home-model"));
    vi.stubEnv("HOME", join(stateDir, "home"));

    expect(resolveConversationSettings(office()).model).toBe("workspace-model");
  });

  test("creates the office's settings directory private to the owner", () => {
    const settingsPath = conversationSettingsPath(office());
    expect(statSync(join(settingsPath, "..")).mode & 0o777).toBe(0o700);
  });

  test("throws when global settings.json is missing", () => {
    expect(() => loadGlobalSettings(stateDir)).toThrow(/Missing global settings file/);
  });

  test("creates onboard settings", () => {
    const settingsPath = createGlobalSettingsFile(stateDir);
    expect(settingsPath).toBe(join(stateDir, "settings.json"));
    const config = loadGlobalSettings(stateDir);
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
    updateGlobalSettings(stateDir, { provider: "openai", model: "gpt-4o" });
    const config = loadGlobalSettings(stateDir);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
  });

  test("reads the GitHub policy from settings.json", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "openai", model: "gpt-4o", thinkingLevel: "off" },
        github: { repos: ["acme/*"], publicRepos: true, triggers: ["mention"] },
      }),
    );
    expect(loadGithubSettings(stateDir)).toEqual({
      repos: ["acme/*"],
      publicRepos: true,
      triggers: ["mention"],
    });
  });

  test("keeps the GitHub policy when another setting changes", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "openai", model: "gpt-4o", thinkingLevel: "off" },
        github: { repos: ["acme/*"] },
      }),
    );
    updateGlobalSettings(stateDir, { model: "gpt-5" });
    expect(loadGithubSettings(stateDir)).toEqual({ repos: ["acme/*"] });
  });

  test("reports a sentry.dsn left in settings.json as ignored", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "openai", model: "gpt-4o", thinkingLevel: "off" },
        sentry: { dsn: "https://public@example.invalid/1" },
      }),
    );
    expect(findUnusedSettings(stateDir, [])).toEqual([
      { path: join(stateDir, "settings.json"), keys: ["sentry"] },
    ]);
  });

  test("reads sandbox cpus, memory, and boost from settings.json", () => {
    updateGlobalSettings(stateDir, {
      sandbox: {
        cpus: "0.5",
        memory: "512m",
        boost: { cpus: "2", memory: "4g" },
      },
    });
    const config = loadGlobalSettings(stateDir);
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
    const config = loadGlobalSettings(stateDir);
    expect(config.sandbox?.cpus).toBeUndefined();
    expect(config.sandbox?.memory).toBeUndefined();
    expect(config.sandbox?.boost?.cpus).toBeUndefined();
    expect(config.sandbox?.boost?.memory).toBeUndefined();
  });

  test("provider and model come from settings.json, not env vars", () => {
    updateGlobalSettings(stateDir, { provider: "openai", model: "gpt-4o" });
    process.env.MIKAN_AI_PROVIDER = "google";
    process.env.MIKAN_AI_MODEL = "gemini-2.0-flash";

    const config = loadGlobalSettings(stateDir);
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
      const config = loadGlobalSettings(stateDir);
      expect(config.provider).toBe("anthropic");
      expect(config.model).toBe("claude-sonnet-4-6");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("throws on malformed settings.json instead of silently falling back", () => {
    writeFileSync(join(stateDir, "settings.json"), "{ invalid json }", "utf-8");
    expect(() => loadGlobalSettings(stateDir)).toThrow(/Malformed settings file/);
  });

  test("throws on settings.json whose top-level value is not an object", () => {
    writeFileSync(join(stateDir, "settings.json"), "[]", "utf-8");
    expect(() => loadGlobalSettings(stateDir)).toThrow(/expected a JSON object/);
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

    expect(() => loadGlobalSettings(stateDir)).toThrow(
      /Malformed settings file.*sandbox.*cpus.*must be string/,
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

    expect(() => loadGlobalSettings(stateDir)).toThrow(
      /Malformed settings file.*thinkingLevel.*must be equal to one of the allowed values/,
    );
  });

  test("throws on conversation settings.json with invalid nested field types", () => {
    createGlobalSettingsFile(stateDir);
    const conversation = office();
    mkdirSync(conversation.stateDir, { recursive: true });
    writeFileSync(
      join(conversation.stateDir, "settings.json"),
      JSON.stringify({ office: { visibility: "everyone" } }),
      "utf-8",
    );

    expect(() => resolveConversationSettings(conversation)).toThrow(
      /Malformed settings file.*visibility/,
    );
  });

  test("conversation model config overrides global provider and model only", () => {
    updateGlobalSettings(stateDir, { provider: "anthropic", model: "claude-sonnet-4-6" });
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
    updateGlobalSettings(stateDir, { sandbox: { cpus: "1", boost: { cpus: "4" } } });
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
    updateGlobalSettings(stateDir, {
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
    updateGlobalSettings(stateDir, { slack: { replyMode: "top-level" } });
    const conversation = office();
    updateConversationSettings(conversation, { slack: { replyMode: "thread" } });

    const config = resolveConversationSettings(conversation);
    expect(config.slack?.replyMode).toBe("thread");
    expect(JSON.parse(readFileSync(conversationSettingsPath(conversation), "utf-8"))).toEqual({
      slack: { replyMode: "thread" },
    });
  });

  test("never reads a settings.json planted in the sandbox-visible office directory", () => {
    createGlobalSettingsFile(stateDir);
    const conversation = office();
    mkdirSync(conversation.dir, { recursive: true });
    writeFileSync(
      join(conversation.dir, "settings.json"),
      JSON.stringify({ sandbox: { memory: "9g" } }),
    );

    expect(resolveConversationSettings(conversation).sandbox?.memory).toBe("1g");
    expect(existsSync(join(conversation.dir, "settings.json"))).toBe(true);
  });
});

describe("updateGlobalSettings", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mikan-test-${Date.now()}-${Math.random()}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
  });

  test("creates settings.json with given config", () => {
    updateGlobalSettings(stateDir, { provider: "google", model: "gemini-2.0-flash" });
    const config = loadGlobalSettings(stateDir);
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
    updateGlobalSettings(stateDir, { provider: "openai", model: "gpt-4o" });
    updateGlobalSettings(stateDir, { model: "gpt-4o-mini" });
    const config = loadGlobalSettings(stateDir);
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
    updateGlobalSettings(nested, { provider: "anthropic" });
    expect(existsSync(join(nested, "settings.json"))).toBe(true);
  });

  test("saves global shared vault settings", () => {
    updateGlobalSettings(stateDir, { sandbox: { defaultSharedVault: "shared-team" } });

    const config = loadGlobalSettings(stateDir);
    expect(config.sandbox?.defaultSharedVault).toBe("shared-team");
    expect(
      JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf-8")).sandbox,
    ).toMatchObject({ defaultSharedVault: "shared-team" });
  });
});
