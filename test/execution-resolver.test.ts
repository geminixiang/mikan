import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGlobalSettingsFile } from "../src/config.js";
import { readConversationWorkspaceMountMode } from "../src/execution-resolver.js";

describe("readConversationWorkspaceMountMode", () => {
  let stateDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mikan-execution-resolver-${Date.now()}`);
    workspaceDir = join(stateDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = stateDir;
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(stateDir)) {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("uses the global default when conversation settings are missing", () => {
    createGlobalSettingsFile(stateDir);

    expect(readConversationWorkspaceMountMode(workspaceDir, "C123")).toBe("private");
  });

  test("falls back to raw conversation settings when merged config cannot load", () => {
    writeFileSync(join(stateDir, "settings.json"), "{ invalid json }", "utf-8");
    const conversationDir = join(workspaceDir, "C123");
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      join(conversationDir, "settings.json"),
      JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }),
      "utf-8",
    );

    expect(readConversationWorkspaceMountMode(workspaceDir, "C123")).toBe("full");
  });

  test("returns the global default when conversation fallback settings are malformed", () => {
    createGlobalSettingsFile(stateDir);
    const conversationDir = join(workspaceDir, "C123");
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(join(conversationDir, "settings.json"), "{ invalid json }", "utf-8");

    expect(readConversationWorkspaceMountMode(workspaceDir, "C123")).toBe("private");
  });
});
