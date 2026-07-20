import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { credentialAuthorizationKey } from "../src/sandbox/identity.js";
import { createGlobalSettingsFile } from "../src/config.js";
import {
  ActorExecutionResolver,
  readConversationWorkspaceMountMode,
} from "../src/execution-resolver.js";
import { FileVaultManager } from "../src/vault/index.js";

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

  test("rejects path-bearing conversation ids before reading or creating directories", () => {
    createGlobalSettingsFile(stateDir);

    for (const conversationId of [
      "",
      ".",
      "..",
      "../events",
      "/tmp/escape",
      "nested/id",
      "nested\\id",
    ]) {
      expect(() => readConversationWorkspaceMountMode(workspaceDir, conversationId)).toThrow(
        /safe path segment/,
      );
    }
  });

  test("resolves private Agent Sandbox workspace mounts", async () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
      { type: "agent-sandbox", warmpool: "mikan-kata", resourceKey: "default", mounts: [] },
      new FileVaultManager(stateDir),
      undefined,
      workspaceDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "C123",
    });

    expect(executor.getSandboxConfig()).toMatchObject({
      type: "agent-sandbox",
      mounts: [],
    });
    expect(existsSync(join(workspaceDir, "C123"))).toBe(true);
  });

  test("resolves the full Agent Sandbox workspace mount", async () => {
    createGlobalSettingsFile(stateDir);
    const conversationDir = join(workspaceDir, "C123");
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      join(conversationDir, "settings.json"),
      JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }),
    );
    const resolver = new ActorExecutionResolver(
      { type: "agent-sandbox", warmpool: "mikan-kata", resourceKey: "default", mounts: [] },
      new FileVaultManager(stateDir),
      undefined,
      workspaceDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "U123",
      conversationId: "C123",
    });

    expect(executor.getSandboxConfig()).toMatchObject({
      type: "agent-sandbox",
      mounts: [],
    });
  });

  test("adds Agent Sandbox vault files to the workspace mounts", async () => {
    createGlobalSettingsFile(stateDir);
    const credentialKey = credentialAuthorizationKey(
      { type: "agent-sandbox", warmpool: "mikan-kata", resourceKey: "default", mounts: [] },
      { userId: "U123", conversationId: "C123" },
    );
    const sshDir = join(stateDir, "vaults", credentialKey, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    const resolver = new ActorExecutionResolver(
      { type: "agent-sandbox", warmpool: "mikan-kata", resourceKey: "default", mounts: [] },
      new FileVaultManager(stateDir),
      undefined,
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

  test("recreates a deleted private conversation directory on the next projection", async () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
      { type: "agent-sandbox", warmpool: "mikan-kata", resourceKey: "default", mounts: [] },
      new FileVaultManager(stateDir),
      undefined,
      workspaceDir,
    );
    const context = { platform: "slack", userId: "U123", conversationId: "C123" } as const;

    await resolver.resolve(context);
    rmSync(join(workspaceDir, "C123"), { recursive: true });
    await resolver.resolve(context);

    expect(existsSync(join(workspaceDir, "C123"))).toBe(true);
  });

  test("fails closed when a vault file mount overlaps the Workspace projection", async () => {
    createGlobalSettingsFile(stateDir);
    const source = join(stateDir, "secret");
    writeFileSync(source, "value");
    const vault = {
      hasEntry: () => true,
      resolve: () => ({
        userId: "key",
        displayName: "key",
        dir: stateDir,
        env: {},
        mounts: [{ source, target: "/workspace/skills/../events/secret" }],
      }),
    } as unknown as FileVaultManager;
    const resolver = new ActorExecutionResolver(
      { type: "agent-sandbox", warmpool: "mikan-kata", resourceKey: "default", mounts: [] },
      vault,
      undefined,
      workspaceDir,
    );

    await expect(
      resolver.resolve({ platform: "slack", userId: "U123", conversationId: "C123" }),
    ).rejects.toThrow(/overlaps protected workspace target/);
  });

  test("does not resolve ambiguous legacy credential keys", async () => {
    createGlobalSettingsFile(stateDir);
    const resolvedKeys: string[] = [];
    const vault = {
      hasEntry: () => false,
      resolve: (key: string) => {
        resolvedKeys.push(key);
        return undefined;
      },
    } as unknown as FileVaultManager;
    const resolver = new ActorExecutionResolver(
      { type: "agent-sandbox", warmpool: "mikan-kata", resourceKey: "default", mounts: [] },
      vault,
      undefined,
      workspaceDir,
    );

    await resolver.resolve({ platform: "slack", userId: "U123", conversationId: "A_B" });
    await resolver.resolve({ platform: "slack", userId: "U123", conversationId: "A-B" });

    expect(resolvedKeys).toHaveLength(2);
    expect(resolvedKeys[0]).not.toBe(resolvedKeys[1]);
    expect(resolvedKeys).not.toContain("a-b");
  });

  test("resolves exact legacy host credentials without enabling lossy managed fallback", async () => {
    createGlobalSettingsFile(stateDir);
    const resolvedKeys: string[] = [];
    const vault = {
      hasEntry: () => true,
      resolve: (key: string) => {
        resolvedKeys.push(key);
        return undefined;
      },
    } as unknown as FileVaultManager;
    const resolver = new ActorExecutionResolver({ type: "host" }, vault, undefined, workspaceDir);

    await resolver.resolve({ platform: "slack", userId: "U123", conversationId: "C123" });

    expect(resolvedKeys).toEqual([expect.stringMatching(/^u123-[a-f0-9]{12}$/), "U123"]);
  });

  test("fails closed when vault file mounts overlap each other", async () => {
    createGlobalSettingsFile(stateDir);
    const firstSource = join(stateDir, "first-secret");
    const secondSource = join(stateDir, "second-secret");
    writeFileSync(firstSource, "first");
    writeFileSync(secondSource, "second");
    const vault = {
      hasEntry: () => true,
      resolve: () => ({
        userId: "key",
        displayName: "key",
        dir: stateDir,
        env: {},
        mounts: [
          { source: firstSource, target: "/root/.config" },
          { source: secondSource, target: "/root/.config/gh" },
        ],
      }),
    } as unknown as FileVaultManager;
    const resolver = new ActorExecutionResolver(
      { type: "agent-sandbox", warmpool: "mikan-kata", resourceKey: "default", mounts: [] },
      vault,
      undefined,
      workspaceDir,
    );

    await expect(
      resolver.resolve({ platform: "slack", userId: "U123", conversationId: "C123" }),
    ).rejects.toThrow(/overlaps vault target/);
  });

  test("fails closed when an adapter cannot mount vault files", async () => {
    createGlobalSettingsFile(stateDir);
    const vault = new FileVaultManager(stateDir);
    const key = credentialAuthorizationKey(
      { type: "cloudflare", sandboxId: "base" },
      { userId: "U123", conversationId: "C123" },
    );
    vault.upsertFile(key, "secret", "value");
    const resolver = new ActorExecutionResolver(
      { type: "cloudflare", sandboxId: "base" },
      vault,
      undefined,
      workspaceDir,
    );

    await expect(
      resolver.resolve({ platform: "slack", userId: "U123", conversationId: "C123" }),
    ).rejects.toThrow(/does not support vault file mounts/);
  });

  test("derives per-actor cloudflare sandbox ids", async () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
      { type: "cloudflare", sandboxId: "mikan-remote" },
      new FileVaultManager(stateDir),
      undefined,
      workspaceDir,
    );

    const executor = await resolver.resolve({
      platform: "slack",
      userId: "alice",
      conversationId: "C123",
    });

    expect(executor.getSandboxConfig()).toEqual({
      type: "cloudflare",
      sandboxId: expect.stringMatching(/^mikan-remote-c123-[a-f0-9]{12}$/),
    });
  });
});
