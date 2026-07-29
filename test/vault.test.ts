import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ActorExecutionResolver } from "../src/execution-resolver.js";
import { DockerContainerManager } from "../src/provisioner.js";
import { HostExecutor } from "../src/sandbox/index.js";
import { credentialAuthorizationKey } from "../src/sandbox/identity.js";
import { FileVaultManager, parseEnvFile, sharedVaultKey } from "../src/vault/index.js";
import { createOfficeAddress, officeDirName, officeKey } from "../src/office/index.js";

const D123_OFFICE = officeDirName(createOfficeAddress("slack", "D123"));

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("parseEnvFile", () => {
  test("parses key value lines and ignores comments", () => {
    expect(parseEnvFile("# comment\nFOO=bar\nEMPTY=\nURL=https://e.test?a=1&b=2\n")).toEqual({
      EMPTY: "",
      FOO: "bar",
      URL: "https://e.test?a=1&b=2",
    });
  });

  test("strips matching single and double quotes", () => {
    expect(parseEnvFile("A=\"hello world\"\nB='ok'")).toEqual({ A: "hello world", B: "ok" });
  });
});

describe("FileVaultManager", () => {
  let tmpDir: string;
  let vaultsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mikan-vault-test-${Date.now()}-${Math.random()}`);
    vaultsDir = join(tmpDir, "vaults");
    mkdirSync(vaultsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  test("is enabled when vaults dir exists", () => {
    expect(new FileVaultManager(tmpDir).isEnabled()).toBe(true);
  });

  test("is not enabled when vaults dir is missing", () => {
    rmSync(vaultsDir, { recursive: true });
    expect(new FileVaultManager(tmpDir).isEnabled()).toBe(false);
  });

  test("list() skips reserved namespaces (shared profiles, extension secrets)", () => {
    mkdirSync(join(vaultsDir, "U123"), { recursive: true });
    writeFileSync(join(vaultsDir, "U123", "env"), "TOKEN=x\n");
    mkdirSync(join(vaultsDir, "shared", "team-login"), { recursive: true });
    mkdirSync(join(vaultsDir, "extensions", "agent-pm"), { recursive: true });
    writeFileSync(join(vaultsDir, "extensions", "agent-pm", "env"), "LINEAR_TOKEN=y\n");

    const keys = new FileVaultManager(tmpDir).list().map((vault) => vault.userId);
    expect(keys).toEqual(["U123"]);
  });

  test("resolves a vault from directory contents", () => {
    const userDir = join(vaultsDir, "U123");
    mkdirSync(join(userDir, ".ssh"), { recursive: true });
    writeFileSync(join(userDir, "env"), "OPENAI_API_KEY=sk-test\n");

    const vault = new FileVaultManager(tmpDir).resolve("U123");

    expect(vault).toMatchObject({
      userId: "U123",
      displayName: "U123",
      env: { OPENAI_API_KEY: "sk-test" },
      mounts: [{ source: join(userDir, ".ssh"), target: "/root/.ssh" }],
    });
  });

  test("rejects traversal keys on read paths", () => {
    const outsidePath = join(tmpDir, "outside");
    mkdirSync(outsidePath, { recursive: true });
    writeFileSync(join(outsidePath, "env"), "TOKEN=outside\n");
    const mgr = new FileVaultManager(tmpDir);

    for (const key of [
      ".",
      "..",
      "../outside",
      "/tmp/outside",
      "nested/../../outside",
      "nested\\\\outside",
      "bad\nkey",
    ]) {
      expect(mgr.hasEntry(key)).toBe(false);
      expect(mgr.resolve(key)).toBeUndefined();
    }
  });

  test("returns undefined for users without a vault directory", () => {
    expect(new FileVaultManager(tmpDir).resolve("UNKNOWN")).toBeUndefined();
  });

  test("rejects traversal keys on write paths", () => {
    const mgr = new FileVaultManager(tmpDir);

    expect(() => mgr.upsertEnv("../outside", { TOKEN: "written" })).toThrow(
      "vault: invalid vault key",
    );
    expect(() => mgr.upsertFile("/tmp/outside", "creds.json", "written")).toThrow(
      "vault: invalid vault key",
    );
    expect(existsSync(join(tmpDir, "outside", "env"))).toBe(false);
  });

  test("upsertEnv creates private files and merges values", () => {
    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertEnv("U123", { OPENAI_API_KEY: "sk-old" });
    mgr.upsertEnv("U123", { GITHUB_TOKEN: "ghp_123", OPENAI_API_KEY: "sk-new" });

    expect(mgr.resolve("U123")?.env).toEqual({
      GITHUB_TOKEN: "ghp_123",
      OPENAI_API_KEY: "sk-new",
    });
    expect(readFileSync(join(vaultsDir, "U123", "env"), "utf-8")).toBe(
      "GITHUB_TOKEN=ghp_123\nOPENAI_API_KEY=sk-new\n",
    );
    expect(mode(vaultsDir) & 0o077).toBe(0);
    expect(mode(join(vaultsDir, "U123")) & 0o077).toBe(0);
    expect(mode(join(vaultsDir, "U123", "env")) & 0o077).toBe(0);
  });

  test("upsertEnv tightens permissions on an existing env file", () => {
    const userDir = join(vaultsDir, "U123");
    mkdirSync(userDir, { recursive: true });
    const envPath = join(userDir, "env");
    writeFileSync(envPath, "OLD=value\n");
    chmodSync(envPath, 0o644);

    new FileVaultManager(tmpDir).upsertEnv("U123", { OPENAI_API_KEY: "sk-test" });

    expect(mode(envPath) & 0o077).toBe(0);
  });

  test("sharedVaultKey validates shared login profile names", () => {
    expect(sharedVaultKey("gliaclaw")).toBe("shared/gliaclaw");
    expect(sharedVaultKey("team.prod-1")).toBe("shared/team.prod-1");
    expect(sharedVaultKey("../secret")).toBeUndefined();
    expect(sharedVaultKey("bad/name")).toBeUndefined();
  });

  test("copySharedVaultTo rejects traversal target keys", () => {
    const sharedDir = join(vaultsDir, "shared", "gliaclaw");
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(join(sharedDir, "env"), "TOKEN=shared\n");
    const mgr = new FileVaultManager(tmpDir);

    expect(() => mgr.copySharedVaultTo("gliaclaw", "../outside")).toThrow(
      "vault: invalid vault key",
    );
    expect(existsSync(join(tmpDir, "outside", "env"))).toBe(false);
  });

  test("copySharedVaultTo merge-copies shared vault into target with shared values winning", () => {
    const sharedDir = join(vaultsDir, "shared", "gliaclaw");
    const targetDir = join(vaultsDir, "c123");
    mkdirSync(join(sharedDir, ".config", "gh"), { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(sharedDir, "env"), "A=profile-a\nB=profile-b\n");
    writeFileSync(join(targetDir, "env"), "A=conversation-a\nD=conversation-d\n");
    writeFileSync(join(sharedDir, ".config", "gh", "hosts.yml"), "github.com:\n  token: shared\n");

    const result = new FileVaultManager(tmpDir).copySharedVaultTo("gliaclaw", "c123");

    expect(result).toEqual({ envKeysCopied: 2, filesCopied: 1 });
    expect(parseEnvFile(readFileSync(join(targetDir, "env"), "utf-8"))).toEqual({
      A: "profile-a",
      B: "profile-b",
      D: "conversation-d",
    });
    expect(readFileSync(join(targetDir, ".config", "gh", "hosts.yml"), "utf-8")).toContain(
      "shared",
    );
  });

  test("lists and deletes shared vaults", () => {
    mkdirSync(join(vaultsDir, "shared", "gliaclaw"), { recursive: true });
    mkdirSync(join(vaultsDir, "shared", "another"), { recursive: true });
    mkdirSync(join(vaultsDir, "shared", ".hidden"), { recursive: true });
    const mgr = new FileVaultManager(tmpDir);

    expect(mgr.listSharedVaults()).toEqual(["another", "gliaclaw"]);
    expect(mgr.deleteSharedVault("gliaclaw")).toBe(true);
    expect(existsSync(join(vaultsDir, "shared", "gliaclaw"))).toBe(false);
  });

  test("upsertFile writes private credential files and persists mount metadata", () => {
    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile(
      "U123",
      "gws.json",
      '{\n  "type": "authorized_user"\n}\n',
      "/root/.config/gws/credentials.json",
    );

    const credentialPath = join(vaultsDir, "U123", "gws.json");
    expect(readFileSync(credentialPath, "utf-8")).toBe('{\n  "type": "authorized_user"\n}\n');
    expect(mode(credentialPath) & 0o077).toBe(0);
    expect(mgr.resolve("U123")?.mounts).toEqual([
      { source: credentialPath, target: "/root/.config/gws/credentials.json" },
    ]);
  });

  test("keeps non-standard OAuth client files on the generic vault mount path", () => {
    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile("U123", "gws-client.json", "{}");

    expect(mgr.resolve("U123")?.mounts).toEqual([
      {
        source: join(vaultsDir, "U123", "gws-client.json"),
        target: "/root/gws-client.json",
      },
    ]);
  });

  test("upsertFile atomically replaces existing mounted credential files", () => {
    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile("U123", "gws.json", "old", "/root/.config/gws/credentials.json");
    const credentialPath = join(vaultsDir, "U123", "gws.json");

    mgr.upsertFile("U123", "gws.json", "new", "/root/.config/gws/credentials.json");

    expect(readFileSync(credentialPath, "utf-8")).toBe("new");
    expect(mode(credentialPath) & 0o077).toBe(0);
  });
});

describe("ActorExecutionResolver image mode", () => {
  let tmpDir: string;
  let vaultsDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mikan-image-vault-test-${Date.now()}-${Math.random()}`);
    vaultsDir = join(tmpDir, "vaults");
    mkdirSync(vaultsDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = tmpDir;
    writeFileSync(
      join(tmpDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
        sandbox: { defaultSharedVault: "" },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MIKAN_STATE_DIR;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("uses platform-namespaced vault ids for new users", async () => {
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      undefined,
      tmpDir,
    );

    const executor = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });

    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mikan-sandbox-d123-e8bafaeb6008",
    });
    expect(mgr.resolve(DockerContainerManager.sanitizeSegment("D123"))).toBeUndefined();
  });

  test("copies the default shared vault for a new image sandbox vault", async () => {
    mkdirSync(join(vaultsDir, "shared", "claw"), { recursive: true });
    writeFileSync(join(vaultsDir, "shared", "claw", "env"), "ANTHROPIC_API_KEY=sk-test\n");
    writeFileSync(
      join(tmpDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
        sandbox: { defaultSharedVault: "claw" },
      }),
    );

    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      new FileVaultManager(tmpDir),
      undefined,
      tmpDir,
    );
    const executor = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });

    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mikan-sandbox-d123-e8bafaeb6008",
    });
    expect(
      readFileSync(
        join(vaultsDir, officeKey(createOfficeAddress("slack", "D123")), "env"),
        "utf-8",
      ),
    ).toContain("ANTHROPIC_API_KEY=sk-test");
  });

  test("github conversations never inherit the default shared vault", async () => {
    mkdirSync(join(vaultsDir, "shared", "claw"), { recursive: true });
    writeFileSync(join(vaultsDir, "shared", "claw", "env"), "GH_TOKEN=ambient\n");
    writeFileSync(
      join(tmpDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
        sandbox: { defaultSharedVault: "claw" },
      }),
    );

    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      undefined,
      tmpDir,
    );
    await resolver.resolve({
      userId: "alice",
      address: createOfficeAddress("github", "GH_octo_widgets_5"),
      trustModel: "open-trigger",
    });

    // The GitHub conversation's sandbox stays credential-free: no vault is
    // provisioned from the ambient default.
    expect(
      mgr.resolve(DockerContainerManager.sanitizeSegment("GH_octo_widgets_5")),
    ).toBeUndefined();

    // Same resolver, same default — a Slack conversation still inherits it.
    await resolver.resolve({ userId: "U1", address: createOfficeAddress("slack", "D999") });
    expect(
      readFileSync(
        join(vaultsDir, officeKey(createOfficeAddress("slack", "D999")), "env"),
        "utf-8",
      ),
    ).toContain("GH_TOKEN=ambient");
  });

  test("does not copy the default shared vault over an existing image sandbox vault", async () => {
    const vaultKey = credentialAuthorizationKey(
      { type: "image", image: "ubuntu:24.04" },
      {
        userId: "U123",
        address: createOfficeAddress("slack", "D123"),
      },
    );
    mkdirSync(join(vaultsDir, "shared", "claw"), { recursive: true });
    mkdirSync(join(vaultsDir, vaultKey), { recursive: true });
    writeFileSync(join(vaultsDir, "shared", "claw", "env"), "A=shared\n");
    writeFileSync(join(vaultsDir, vaultKey, "env"), "A=existing\n");
    writeFileSync(
      join(tmpDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
        sandbox: { defaultSharedVault: "claw" },
      }),
    );

    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      new FileVaultManager(tmpDir),
      undefined,
      tmpDir,
    );
    await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });

    expect(parseEnvFile(readFileSync(join(vaultsDir, vaultKey, "env"), "utf-8"))).toEqual({
      A: "existing",
    });
  });

  test("login and execution use the same generated vault key in image mode", async () => {
    const mgr = new FileVaultManager(tmpDir);
    const baseConfig = { type: "image", image: "ubuntu:24.04" } as const;
    const vaultKey = credentialAuthorizationKey(baseConfig, {
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });

    const resolver = new ActorExecutionResolver(baseConfig, mgr, undefined, tmpDir);
    const executor = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });

    expect(vaultKey).toBe(officeKey(createOfficeAddress("slack", "D123")));
    expect(executor.getSandboxConfig()).toEqual({
      type: "container",
      container: "mikan-sandbox-d123-e8bafaeb6008",
    });
  });

  test("rejects cloudflare as a persistent conversation office", async () => {
    const mgr = new FileVaultManager(tmpDir);
    const resolver = new ActorExecutionResolver(
      { type: "cloudflare", sandboxId: "mikan-remote" },
      mgr,
    );

    await expect(
      resolver.resolve({
        userId: "U123",
        address: createOfficeAddress("slack", "D123"),
      }),
    ).rejects.toThrow(/cannot provide an isolated conversation office/);

    expect(mgr.resolve(DockerContainerManager.sanitizeSegment("D123"))).toBeUndefined();
  });

  test("provisions per-conversation container with inferred vault mounts", async () => {
    const vaultKey = credentialAuthorizationKey(
      { type: "image", image: "ubuntu:24.04" },
      {
        userId: "U123",
        address: createOfficeAddress("slack", "D123"),
      },
    );
    const userDir = join(vaultsDir, vaultKey);
    mkdirSync(join(userDir, ".ssh"), { recursive: true });

    const mgr = new FileVaultManager(tmpDir);
    const provision = vi.fn().mockResolvedValue("mikan-sandbox-d123-e8bafaeb6008");
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      { provision } as any,
      tmpDir,
    );

    const executor = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });
    await executor.exec("pwd");

    expect(provision).toHaveBeenCalledWith("d123-e8bafaeb6008", {
      containerName: "mikan-sandbox-d123-e8bafaeb6008",
      conversationId: "D123",
      mounts: [
        { source: join(tmpDir, D123_OFFICE), target: `/workspace/${D123_OFFICE}` },
        { source: join(vaultsDir, vaultKey, ".ssh"), target: "/root/.ssh" },
      ],
    });
    expect(exec).toHaveBeenCalledWith(
      "docker exec -w /workspace mikan-sandbox-d123-e8bafaeb6008 sh -c 'pwd'",
      undefined,
    );
  });

  test("mounts the full workspace when conversation sandbox mode is full", async () => {
    mkdirSync(join(tmpDir, D123_OFFICE), { recursive: true });
    writeFileSync(
      join(tmpDir, D123_OFFICE, "settings.json"),
      JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }) + "\n",
    );

    const mgr = new FileVaultManager(tmpDir);
    const provision = vi.fn().mockResolvedValue("mikan-sandbox-d123-e8bafaeb6008");
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      { provision } as any,
      tmpDir,
    );

    const executor = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });
    await executor.exec("pwd");

    expect(provision).toHaveBeenCalledWith("d123-e8bafaeb6008", {
      containerName: "mikan-sandbox-d123-e8bafaeb6008",
      conversationId: "D123",
      mounts: [{ source: tmpDir, target: "/workspace" }],
    });
    expect(exec).toHaveBeenCalledWith(
      "docker exec -w /workspace mikan-sandbox-d123-e8bafaeb6008 sh -c 'pwd'",
      undefined,
    );
  });
});
