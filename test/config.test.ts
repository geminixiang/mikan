import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createGlobalSettingsFile,
  loadAgentConfig,
  loadAgentConfigForConversation,
  resolveSentryDsn,
  resolveStateDirFromArgv,
  resolveWorkspaceDirFromArgv,
  saveAgentConfig,
  saveConversationModelConfig,
  saveConversationSandboxConfig,
} from "../src/config.js";

describe("loadAgentConfig", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mama-test-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    process.env.MAMA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MAMA_STATE_DIR;
    delete process.env.MAMA_AI_PROVIDER;
    delete process.env.MAMA_AI_MODEL;
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
  });

  test("throws when global settings.json is missing", () => {
    expect(() => loadAgentConfig()).toThrow(/Missing global settings file/);
  });

  test("creates onboard settings", () => {
    const settingsPath = createGlobalSettingsFile(stateDir);
    expect(settingsPath).toBe(join(stateDir, "settings.json"));
    const config = loadAgentConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.thinkingLevel).toBe("off");
    expect(config.logFormat).toBe("console");
    expect(config.logLevel).toBe("info");
    expect(config.sandboxCpus).toBe("0.5");
    expect(config.sandboxMemory).toBe("1g");
    expect(config.sandboxBoostCpus).toBe("2");
    expect(config.sandboxBoostMemory).toBe("4g");
    expect(config.sandboxImageWorkspaceMount).toBe("private");
  });

  test("reads provider and model from settings.json", () => {
    saveAgentConfig({ provider: "openai", model: "gpt-4o" });
    const config = loadAgentConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
  });

  test("reads sentryDsn from settings.json", () => {
    saveAgentConfig({ sentryDsn: "https://examplePublicKey@o0.ingest.sentry.io/0" });
    const config = loadAgentConfig();
    expect(config.sentryDsn).toBe("https://examplePublicKey@o0.ingest.sentry.io/0");
  });

  test("reads sandboxCpus, sandboxMemory, and sandbox boost from settings.json", () => {
    saveAgentConfig({
      sandboxCpus: "0.5",
      sandboxMemory: "512m",
      sandboxBoostCpus: "2",
      sandboxBoostMemory: "4g",
    });
    const config = loadAgentConfig();
    expect(config.sandboxCpus).toBe("0.5");
    expect(config.sandboxMemory).toBe("512m");
    expect(config.sandboxBoostCpus).toBe("2");
    expect(config.sandboxBoostMemory).toBe("4g");
  });

  test("sandboxCpus and sandboxMemory are undefined when omitted from settings", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
        log: { format: "console", level: "info" },
      }),
      "utf-8",
    );
    const config = loadAgentConfig();
    expect(config.sandboxCpus).toBeUndefined();
    expect(config.sandboxMemory).toBeUndefined();
    expect(config.sandboxBoostCpus).toBeUndefined();
    expect(config.sandboxBoostMemory).toBeUndefined();
  });

  test("provider and model come from settings.json, not env vars", () => {
    saveAgentConfig({ provider: "openai", model: "gpt-4o" });
    process.env.MAMA_AI_PROVIDER = "google";
    process.env.MAMA_AI_MODEL = "gemini-2.0-flash";

    const config = loadAgentConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
  });

  test("ignores settings.json in non-state directories", () => {
    const otherDir = join(tmpdir(), `mama-other-${Date.now()}`);
    mkdirSync(otherDir, { recursive: true });
    try {
      writeFileSync(
        join(otherDir, "settings.json"),
        JSON.stringify({ llm: { provider: "openai", model: "gpt-4o" } }),
        "utf-8",
      );
      createGlobalSettingsFile(stateDir);
      const config = loadAgentConfig();
      expect(config.provider).toBe("anthropic");
      expect(config.model).toBe("claude-sonnet-4-6");
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("throws on malformed settings.json instead of silently falling back", () => {
    writeFileSync(join(stateDir, "settings.json"), "{ invalid json }", "utf-8");
    expect(() => loadAgentConfig()).toThrow(/Malformed settings file/);
  });

  test("throws on settings.json whose top-level value is not an object", () => {
    writeFileSync(join(stateDir, "settings.json"), "[]", "utf-8");
    expect(() => loadAgentConfig()).toThrow(/expected a JSON object/);
  });

  test("throws on settings.json with invalid nested field types", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
        log: { format: "console", level: "info" },
        sandbox: { cpus: 2 },
      }),
      "utf-8",
    );

    expect(() => loadAgentConfig()).toThrow(
      /Malformed settings file.*sandbox.*cpus.*Expected string/,
    );
  });

  test("throws on settings.json with invalid thinkingLevel", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "on" },
        log: { format: "console", level: "info" },
      }),
      "utf-8",
    );

    expect(() => loadAgentConfig()).toThrow(
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

    expect(() => loadAgentConfigForConversation(conversationDir)).toThrow(
      /Malformed settings file.*workspaceMount/,
    );
  });

  test("conversation model config overrides global provider and model only", () => {
    saveAgentConfig({ provider: "anthropic", model: "claude-sonnet-4-6" });
    const conversationDir = join(stateDir, "workspace", "C123");
    saveConversationModelConfig(conversationDir, {
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "low",
    });

    const config = loadAgentConfigForConversation(conversationDir);
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
    expect(config.thinkingLevel).toBe("low");
    expect(JSON.parse(readFileSync(join(conversationDir, "settings.json"), "utf-8"))).toEqual({
      llm: { provider: "openai", model: "gpt-4o", thinkingLevel: "low" },
    });
  });

  test("conversation sandbox config overrides global image workspace mount", () => {
    createGlobalSettingsFile(stateDir);
    const conversationDir = join(stateDir, "workspace", "C123");
    saveConversationSandboxConfig(conversationDir, { imageWorkspaceMount: "full" });

    const config = loadAgentConfigForConversation(conversationDir);
    expect(config.sandboxImageWorkspaceMount).toBe("full");
    expect(JSON.parse(readFileSync(join(conversationDir, "settings.json"), "utf-8"))).toEqual({
      sandbox: { image: { workspaceMount: "full" } },
    });
  });
});

describe("argv config resolution", () => {
  test("returns the positional workspace dir", () => {
    expect(resolveWorkspaceDirFromArgv(["--sandbox=host", "/tmp/mama"])).toBe("/tmp/mama");
  });

  test("skips flag values before resolving workspace dir", () => {
    expect(resolveWorkspaceDirFromArgv(["--sandbox", "host", "/tmp/mama"])).toBe("/tmp/mama");
  });

  test("ignores download mode channel ids", () => {
    expect(resolveWorkspaceDirFromArgv(["--download", "C123"])).toBeUndefined();
  });

  test("resolves explicit state-dir from argv", () => {
    expect(resolveStateDirFromArgv(["--state-dir", "/tmp/state", "/tmp/mama"])).toBe("/tmp/state");
    expect(resolveStateDirFromArgv(["--state-dir=/tmp/state", "/tmp/mama"])).toBe("/tmp/state");
  });
});

describe("resolveSentryDsn", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mama-test-sentry-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    process.env.MAMA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MAMA_STATE_DIR;
    delete process.env.SENTRY_DSN;
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
  });

  test("prefers settings.json over env", () => {
    saveAgentConfig({ sentryDsn: "https://settings.example/1" });
    process.env.SENTRY_DSN = "https://env.example/1";
    expect(resolveSentryDsn()).toBe("https://settings.example/1");
  });

  test("falls back to env when settings.json has no sentryDsn", () => {
    process.env.SENTRY_DSN = "https://env.example/2";
    expect(resolveSentryDsn()).toBe("https://env.example/2");
  });
});

describe("saveAgentConfig", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mama-test-${Date.now()}`);
    mkdirSync(stateDir, { recursive: true });
    process.env.MAMA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MAMA_STATE_DIR;
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true });
  });

  test("creates settings.json with given config", () => {
    saveAgentConfig({ provider: "google", model: "gemini-2.0-flash" });
    const config = loadAgentConfig();
    expect(config.provider).toBe("google");
    expect(config.model).toBe("gemini-2.0-flash");
    expect(JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf-8"))).toEqual({
      llm: {
        provider: "google",
        model: "gemini-2.0-flash",
        thinkingLevel: "off",
        autoReply: { provider: "anthropic", model: "claude-haiku-4-5" },
      },
      log: { format: "console", level: "info" },
      sandbox: {
        cpus: "0.5",
        memory: "1g",
        boost: { cpus: "2", memory: "4g" },
        image: { workspaceMount: "private" },
      },
    });
  });

  test("merges with existing settings — preserves unrelated fields", () => {
    saveAgentConfig({ provider: "openai", model: "gpt-4o", logLevel: "debug" });
    saveAgentConfig({ model: "gpt-4o-mini" });
    const config = loadAgentConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o-mini");
    expect(config.logLevel).toBe("debug");
    expect(JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf-8"))).toEqual({
      llm: {
        provider: "openai",
        model: "gpt-4o-mini",
        thinkingLevel: "off",
        autoReply: { provider: "anthropic", model: "claude-haiku-4-5" },
      },
      log: { format: "console", level: "debug" },
      sandbox: {
        cpus: "0.5",
        memory: "1g",
        boost: { cpus: "2", memory: "4g" },
        image: { workspaceMount: "private" },
      },
    });
  });

  test("creates parent directories if they don't exist", () => {
    const nested = join(stateDir, "a", "b", "c");
    process.env.MAMA_STATE_DIR = nested;
    saveAgentConfig({ provider: "anthropic" });
    expect(existsSync(join(nested, "settings.json"))).toBe(true);
  });
});
