import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGlobalSettingsFile, loadAgentConfig, saveAgentConfig } from "../src/config.js";
import * as log from "../src/log.js";

describe("log config from settings.json", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mama-test-log-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.MAMA_STATE_DIR = tmpDir;
    createGlobalSettingsFile(tmpDir);
  });

  afterEach(() => {
    delete process.env.MAMA_STATE_DIR;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("logFormat defaults to console", () => {
    const config = loadAgentConfig();
    expect(config.logFormat).toBe("console");
  });

  test("logLevel defaults to info", () => {
    const config = loadAgentConfig();
    expect(config.logLevel).toBe("info");
  });

  test("reads logFormat from settings.json", () => {
    saveAgentConfig({ logFormat: "json" });
    const config = loadAgentConfig();
    expect(config.logFormat).toBe("json");
  });

  test("reads logLevel from settings.json", () => {
    saveAgentConfig({ logLevel: "debug" });
    const config = loadAgentConfig();
    expect(config.logLevel).toBe("debug");
  });

  test("reads both logFormat and logLevel from settings.json", () => {
    saveAgentConfig({ logFormat: "json", logLevel: "warn" });
    const config = loadAgentConfig();
    expect(config.logFormat).toBe("json");
    expect(config.logLevel).toBe("warn");
  });

  test("settings.json with all config fields", () => {
    writeFileSync(
      join(tmpDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "openai", model: "gpt-4o", thinkingLevel: "off" },
        log: { format: "json", level: "debug" },
      }),
      "utf-8",
    );
    const config = loadAgentConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
    expect(config.thinkingLevel).toBe("off");
    expect(config.logFormat).toBe("json");
    expect(config.logLevel).toBe("debug");
  });
});

describe("initLogger", () => {
  afterEach(() => {
    log.__resetLoggerForTest();
  });

  test("initLogger accepts valid logFormat and logLevel", () => {
    expect(() => {
      log.initLogger({ logFormat: "console", logLevel: "info" });
    }).not.toThrow();
  });

  test("initLogger works with json format", () => {
    // Should not throw even if GCP credentials aren't available
    // It will warn but not throw
    expect(() => {
      log.initLogger({ logFormat: "json", logLevel: "info" });
    }).not.toThrow();
  });

  test("initLogger works with undefined config (uses defaults)", () => {
    expect(() => {
      log.initLogger();
    }).not.toThrow();
  });

  test("initLogger accepts all log levels", () => {
    const levels = ["trace", "debug", "info", "warn", "error"] as const;
    for (const level of levels) {
      log.__resetLoggerForTest();
      expect(() => {
        log.initLogger({ logFormat: "console", logLevel: level });
      }).not.toThrow();
    }
  });

  test("initLogger is idempotent - second call is no-op", () => {
    log.initLogger({ logFormat: "json", logLevel: "info" });
    // Second call should not throw or create a new logger
    expect(() => {
      log.initLogger({ logFormat: "json", logLevel: "debug" });
    }).not.toThrow();
  });
});

describe("log functions exist", () => {
  test("all expected log functions are exported", () => {
    expect(typeof log.logUserMessage).toBe("function");
    expect(typeof log.logToolStart).toBe("function");
    expect(typeof log.logToolSuccess).toBe("function");
    expect(typeof log.logToolError).toBe("function");
    expect(typeof log.logResponse).toBe("function");
    expect(typeof log.logThinking).toBe("function");
    expect(typeof log.logInfo).toBe("function");
    expect(typeof log.logWarning).toBe("function");
    expect(typeof log.logAgentError).toBe("function");
    expect(typeof log.logStartup).toBe("function");
    expect(typeof log.logConnected).toBe("function");
    expect(typeof log.logDisconnected).toBe("function");
    expect(typeof log.initLogger).toBe("function");
  });
});
