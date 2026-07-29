import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { credentialAuthorizationKey } from "../sandbox/identity.js";
import { createGlobalSettingsFile } from "../config.js";
import { ActorExecutionResolver } from "../execution-resolver.js";
import { FileVaultManager } from "../vault/index.js";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";

const C123_OFFICE = officeKey(createOfficeAddress("slack", "C123"));

describe("ActorExecutionResolver", () => {
  // the Gondolin executor asserts Node >=23.6, but CI also runs the 22.19.0 floor
  const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
  let stateDir: string;
  let workspaceDir: string;

  const workspace = () => createWorkspace({ root: workspaceDir, stateDir });

  beforeEach(() => {
    // mkdtemp, not Date.now(): two tests entering the same millisecond would
    // otherwise share a state dir, and one's cleanup would race the other's
    // setup (ENOTEMPTY).
    stateDir = mkdtempSync(join(tmpdir(), "mikan-execution-resolver-"));
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

  test("fails closed instead of escalating from raw fallback settings", async () => {
    writeFileSync(join(stateDir, "settings.json"), "{ invalid json }", "utf-8");
    const conversationDir = join(workspaceDir, C123_OFFICE);
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      join(conversationDir, "settings.json"),
      JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }),
      "utf-8",
    );
    const resolver = new ActorExecutionResolver(
      { type: "gondolin", profile: "default" },
      new FileVaultManager(stateDir),
      undefined,
      workspace(),
    );

    await expect(
      resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "C123") }),
    ).rejects.toThrow(/settings are malformed/);
  });

  test("fails closed when legacy conversation settings are malformed", async () => {
    createGlobalSettingsFile(stateDir);
    const conversationDir = join(workspaceDir, C123_OFFICE);
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(join(conversationDir, "settings.json"), "{ invalid json }", "utf-8");
    const resolver = new ActorExecutionResolver(
      { type: "gondolin", profile: "default" },
      new FileVaultManager(stateDir),
      undefined,
      workspace(),
    );

    await expect(
      resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "C123") }),
    ).rejects.toThrow(/settings are malformed/);
  });

  test("rejects path-bearing conversation ids before reading or creating directories", () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
      { type: "gondolin", profile: "default" },
      new FileVaultManager(stateDir),
      undefined,
      workspace(),
    );

    for (const conversationId of [
      "",
      ".",
      "..",
      "../events",
      "/tmp/escape",
      "nested/id",
      "nested\\id",
    ]) {
      // Identity validation moved to the address factory, ahead of any
      // directory reads or creation: the address never reaches `resolve`.
      expect(() =>
        resolver.resolve({
          userId: "U123",
          address: createOfficeAddress("slack", conversationId),
        }),
      ).toThrow(/Conversation id|Unsupported platform/);
    }
  });

  test("resolves isolated Gondolin workspace mounts", async () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
      { type: "gondolin", profile: "default" },
      new FileVaultManager(stateDir),
      undefined,
      workspace(),
    );

    const executor = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "C123"),
    });

    expect(executor.getSandboxConfig()).toMatchObject({
      type: "gondolin",
      mounts: [{ source: join(workspaceDir, C123_OFFICE), target: `/workspace/${C123_OFFICE}` }],
    });
    expect(existsSync(join(workspaceDir, C123_OFFICE))).toBe(true);
  });

  test("resolves the full Gondolin workspace mount", async () => {
    createGlobalSettingsFile(stateDir);
    const conversationDir = join(workspaceDir, C123_OFFICE);
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      join(conversationDir, "settings.json"),
      JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }),
    );
    const resolver = new ActorExecutionResolver(
      { type: "gondolin", profile: "default" },
      new FileVaultManager(stateDir),
      undefined,
      workspace(),
    );

    const executor = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "C123"),
    });

    expect(executor.getSandboxConfig()).toMatchObject({
      type: "gondolin",
      mounts: [{ source: workspaceDir, target: "/workspace" }],
    });
  });

  test("adds Gondolin vault files to the workspace mounts", async () => {
    createGlobalSettingsFile(stateDir);
    const credentialKey = credentialAuthorizationKey(
      { type: "gondolin", profile: "default" },
      {
        userId: "U123",
        address: createOfficeAddress("slack", "C123"),
      },
    );
    const sshDir = join(stateDir, "vaults", credentialKey, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    const resolver = new ActorExecutionResolver(
      { type: "gondolin", profile: "default" },
      new FileVaultManager(stateDir),
      undefined,
      workspace(),
    );

    const executor = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "C123"),
    });

    expect(executor.getSandboxConfig()).toMatchObject({
      mounts: expect.arrayContaining([{ source: sshDir, target: "/root/.ssh" }]),
    });
  });

  test("recreates a deleted private conversation directory on the next projection", async () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
      { type: "gondolin", profile: "default" },
      new FileVaultManager(stateDir),
      undefined,
      workspace(),
    );
    const context = { userId: "U123", address: createOfficeAddress("slack", "C123") } as const;

    await resolver.resolve(context);
    rmSync(join(workspaceDir, C123_OFFICE), { recursive: true });
    await resolver.resolve(context);

    expect(existsSync(join(workspaceDir, C123_OFFICE))).toBe(true);
  });

  test("fails closed when a vault file mount overlaps the Workspace projection", async () => {
    createGlobalSettingsFile(stateDir);
    const settingsPath = join(stateDir, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      sandbox: Record<string, unknown>;
    };
    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...settings,
        sandbox: {
          ...settings.sandbox,
          workspace: { doorPolicy: "trusted", layout: "shared-support" },
        },
      }),
    );
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
      { type: "gondolin", profile: "default" },
      vault,
      undefined,
      workspace(),
    );

    await expect(
      resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "C123") }),
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
      { type: "gondolin", profile: "default" },
      vault,
      undefined,
      workspace(),
    );

    await resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "A_B") });
    await resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "A-B") });

    expect(resolvedKeys).toHaveLength(2);
    expect(resolvedKeys[0]).not.toBe(resolvedKeys[1]);
    expect(resolvedKeys).not.toContain("a-b");
  });

  test("rejects host as an isolated office after preserving legacy credential lookup", async () => {
    createGlobalSettingsFile(stateDir);
    const resolvedKeys: string[] = [];
    const vault = {
      hasEntry: () => true,
      resolve: (key: string) => {
        resolvedKeys.push(key);
        return undefined;
      },
    } as unknown as FileVaultManager;
    const resolver = new ActorExecutionResolver({ type: "host" }, vault, undefined, workspace());

    await expect(
      resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "C123") }),
    ).rejects.toThrow(/cannot provide an isolated conversation office/);

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
      { type: "gondolin", profile: "default" },
      vault,
      undefined,
      workspace(),
    );

    await expect(
      resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "C123") }),
    ).rejects.toThrow(/overlaps vault target/);
  });

  test("fails closed when an adapter cannot mount vault files", async () => {
    createGlobalSettingsFile(stateDir);
    const vault = new FileVaultManager(stateDir);
    const key = credentialAuthorizationKey(
      { type: "cloudflare", sandboxId: "base" },
      {
        userId: "U123",
        address: createOfficeAddress("slack", "C123"),
      },
    );
    vault.upsertFile(key, "secret", "value");
    const resolver = new ActorExecutionResolver(
      { type: "cloudflare", sandboxId: "base" },
      vault,
      undefined,
      workspace(),
    );

    await expect(
      resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "C123") }),
    ).rejects.toThrow(/does not support vault file mounts/);
  });

  test("derives cloudflare actor identity before rejecting it as an office", async () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
      { type: "cloudflare", sandboxId: "mikan-remote" },
      new FileVaultManager(stateDir),
      undefined,
      workspace(),
    );

    await expect(
      resolver.resolve({
        userId: "alice",
        address: createOfficeAddress("slack", "C123"),
      }),
    ).rejects.toThrow(/cannot provide an isolated conversation office/);
  });
});
