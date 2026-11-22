import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createGlobalSettingsFile } from "../settings/index.js";
import { ActorExecutionResolver } from "../harness/execution-resolver.js";
import { FileVaultManager } from "../vault/index.js";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";
import { recordPlatformChannelKind } from "../office/projection.js";

const C123_OFFICE = officeKey(createOfficeAddress("slack", "C123"));

type ResolverVault = ConstructorParameters<typeof ActorExecutionResolver>[0];

function fakeVault(lookup: Pick<ResolverVault, "hasEntry" | "resolve">): ResolverVault {
  return {
    ...lookup,
    copySharedVaultTo: () => {
      throw new Error("unexpected shared vault copy");
    },
  };
}

describe("ActorExecutionResolver", () => {
  let stateDir: string;
  let workspaceDir: string;

  const workspace = () => createWorkspace({ root: workspaceDir, stateDir });

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mikan-execution-resolver-"));
    workspaceDir = join(stateDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(stateDir)) {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("a legacy full override never escalates to a workspace-root mount", async () => {
    createGlobalSettingsFile(stateDir);
    const conversationDir = join(workspaceDir, C123_OFFICE);
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      join(conversationDir, "settings.json"),
      JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }),
      "utf-8",
    );
    const resolver = new ActorExecutionResolver(
      new FileVaultManager(stateDir),
      undefined,
      workspace(),
    );

    const decision = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "C123"),
    });
    expect(decision.projection.mounts.some((mount) => mount.source === workspaceDir)).toBe(false);
  });

  test("fails closed when conversation settings are malformed", async () => {
    createGlobalSettingsFile(stateDir);
    const settingsDir = join(stateDir, "conversations", C123_OFFICE);
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(join(settingsDir, "settings.json"), "{ invalid json }", "utf-8");
    const resolver = new ActorExecutionResolver(
      new FileVaultManager(stateDir),
      undefined,
      workspace(),
    );

    await expect(
      resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "C123") }),
    ).rejects.toThrow(/Malformed settings file/);
  });

  test("rejects path-bearing conversation ids before reading or creating directories", () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
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
      expect(() =>
        resolver.resolve({
          userId: "U123",
          address: createOfficeAddress("slack", conversationId),
        }),
      ).toThrow(/Conversation id|Unsupported platform/);
    }
  });

  test("materializes the conversation office directory on resolve", async () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
      new FileVaultManager(stateDir),
      undefined,
      workspace(),
    );

    const decision = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "C123"),
    });

    expect(decision.pathContext).toMatchObject({
      hostWorkspaceRoot: workspaceDir,
      runtimeWorkspaceRoot: "/workspace",
    });
    expect(decision.projection).toMatchObject({ visibility: "private", source: "unknown" });
    expect(existsSync(join(workspaceDir, C123_OFFICE))).toBe(true);
  });

  test("recreates a deleted private conversation directory on the next projection", async () => {
    createGlobalSettingsFile(stateDir);
    const resolver = new ActorExecutionResolver(
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
    const vault = fakeVault({
      hasEntry: () => true,
      resolve: () => ({
        userId: "key",
        displayName: "key",
        dir: stateDir,
        env: {},
        mounts: [{ source, target: "/workspace/MEMORY.md/../skills/secret" }],
      }),
    });
    const resolver = new ActorExecutionResolver(vault, undefined, workspace());

    await expect(
      resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "C123") }),
    ).rejects.toThrow(/overlaps protected workspace target/);
  });

  test("does not resolve ambiguous legacy credential keys", async () => {
    createGlobalSettingsFile(stateDir);
    const resolvedKeys: string[] = [];
    const vault = fakeVault({
      hasEntry: () => false,
      resolve: (key: string) => {
        resolvedKeys.push(key);
        return undefined;
      },
    });
    const resolver = new ActorExecutionResolver(vault, undefined, workspace());

    await resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "A_B") });
    await resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "A-B") });

    expect(resolvedKeys).toHaveLength(2);
    expect(resolvedKeys[0]).not.toBe(resolvedKeys[1]);
    expect(resolvedKeys).not.toContain("a-b");
  });

  test("allows image mode for a platform-derived private channel", async () => {
    createGlobalSettingsFile(stateDir);
    const currentWorkspace = workspace();
    const address = createOfficeAddress("slack", "C123");
    recordPlatformChannelKind(currentWorkspace.office(address), "private_channel");
    const resolver = new ActorExecutionResolver(
      new FileVaultManager(stateDir),
      undefined,
      currentWorkspace,
    );

    await expect(resolver.resolve({ userId: "U123", address })).resolves.toBeDefined();
  });

  test("fails closed when vault file mounts overlap each other", async () => {
    createGlobalSettingsFile(stateDir);
    const firstSource = join(stateDir, "first-secret");
    const secondSource = join(stateDir, "second-secret");
    writeFileSync(firstSource, "first");
    writeFileSync(secondSource, "second");
    const vault = fakeVault({
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
    });
    const resolver = new ActorExecutionResolver(vault, undefined, workspace());

    await expect(
      resolver.resolve({ userId: "U123", address: createOfficeAddress("slack", "C123") }),
    ).rejects.toThrow(/overlaps vault target/);
  });
});
