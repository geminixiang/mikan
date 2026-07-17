import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGlobalSettingsFile } from "../src/config.js";
import {
  ActorExecutionResolver,
  readConversationWorkspaceMountMode,
} from "../src/execution-resolver.js";
import { FileVaultManager } from "../src/vault/index.js";

describe("readConversationWorkspaceMountMode", () => {
  // the Gondolin executor asserts Node >=23.6, but CI also runs the 22.19.0 floor
  const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
  let stateDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `mikan-execution-resolver-${Date.now()}`);
    workspaceDir = join(stateDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = stateDir;
    Object.defineProperty(process.versions, "node", { value: "24.0.0", configurable: true });
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    if (nodeVersion) Object.defineProperty(process.versions, "node", nodeVersion);
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

  test("resolves private Gondolin workspace mounts", async () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
      { type: "gondolin", profile: "default" },
      new FileVaultManager(stateDir),
      undefined,
      workspaceDir,
      workspaceDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "C123",
    });

    expect(executor.getSandboxConfig()).toMatchObject({
      type: "gondolin",
      mounts: [
        { source: join(workspaceDir, "MEMORY.md"), target: "/workspace/MEMORY.md" },
        { source: join(workspaceDir, "skills"), target: "/workspace/skills" },
        { source: join(workspaceDir, "events"), target: "/workspace/events" },
        { source: join(workspaceDir, "C123"), target: "/workspace/C123" },
      ],
    });
    expect(existsSync(join(workspaceDir, "C123"))).toBe(true);
  });

  test("resolves the full Gondolin workspace mount", async () => {
    createGlobalSettingsFile(stateDir);
    const conversationDir = join(workspaceDir, "C123");
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      join(conversationDir, "settings.json"),
      JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }),
    );
    const resolver = new ActorExecutionResolver(
      { type: "gondolin", profile: "default" },
      new FileVaultManager(stateDir),
      undefined,
      workspaceDir,
      workspaceDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "C123",
    });

    expect(executor.getSandboxConfig()).toMatchObject({
      type: "gondolin",
      mounts: [{ source: workspaceDir, target: "/workspace" }],
    });
  });

  test("adds Gondolin vault files to the workspace mounts", async () => {
    createGlobalSettingsFile(stateDir);
    const sshDir = join(stateDir, "vaults", "c123", ".ssh");
    mkdirSync(sshDir, { recursive: true });
    const resolver = new ActorExecutionResolver(
      { type: "gondolin", profile: "default" },
      new FileVaultManager(stateDir),
      undefined,
      workspaceDir,
      workspaceDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "C123",
    });

    expect(executor.getSandboxConfig()).toMatchObject({
      mounts: expect.arrayContaining([{ source: sshDir, target: "/root/.ssh" }]),
    });
  });

  test("derives per-actor cloudflare sandbox ids", async () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
      { type: "cloudflare", sandboxId: "mikan-remote" },
      new FileVaultManager(stateDir),
      undefined,
      workspaceDir,
      workspaceDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "alice",
      conversationId: "C123",
    });

    expect(executor.getSandboxConfig()).toEqual({
      type: "cloudflare",
      sandboxId: "mikan-remote-c123",
    });
  });
});
