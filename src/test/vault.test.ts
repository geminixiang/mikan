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
import { ActorExecutionResolver } from "../harness/execution-resolver.js";
import { DockerContainerManager } from "../sandbox/provisioner.js";
import { HostExecutor } from "../sandbox/index.js";
import { credentialAuthorizationKey } from "../sandbox/identity.js";
import { FileVaultManager, parseEnvFile, sharedVaultKey } from "../vault/index.js";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";

const D123_OFFICE = officeKey(createOfficeAddress("slack", "D123"));

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

  test("skips lines without '=' or without a key, keeps mismatched quotes", () => {
    expect(parseEnvFile("NOEQUALS\n=value\nA='mismatched\"\nB=b")).toEqual({
      A: "'mismatched\"",
      B: "b",
    });
  });

  test("handles CRLF line endings", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
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

  test("deleteEnvKey removes one variable and reports absence", () => {
    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertEnv("extensions/agent-pm", { SLACK_BOT_TOKEN: "xoxb-1", OPENAI_API_KEY: "sk-1" });

    expect(mgr.deleteEnvKey("extensions/agent-pm", "SLACK_BOT_TOKEN")).toBe(true);
    expect(mgr.resolve("extensions/agent-pm")?.env).toEqual({ OPENAI_API_KEY: "sk-1" });
    expect(mgr.deleteEnvKey("extensions/agent-pm", "SLACK_BOT_TOKEN")).toBe(false);
    expect(mgr.deleteEnvKey("extensions/never-installed", "TOKEN")).toBe(false);
    expect(() => mgr.deleteEnvKey("../outside", "TOKEN")).toThrow("vault: invalid vault key");
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

  test("copySharedVaultTo preserves explicit mount targets", () => {
    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile("shared/gliaclaw", "custom.json", "secret", "/opt/provider/credentials.json");

    mgr.copySharedVaultTo("gliaclaw", "U123");

    expect(mgr.resolve("U123")?.mounts).toEqual([
      {
        source: join(vaultsDir, "U123", "custom.json"),
        target: "/opt/provider/credentials.json",
      },
    ]);
  });

  test("lists and deletes shared vaults", () => {
    mkdirSync(join(vaultsDir, "shared", "gliaclaw"), { recursive: true });
    mkdirSync(join(vaultsDir, "shared", "another"), { recursive: true });
    mkdirSync(join(vaultsDir, "shared", ".hidden"), { recursive: true });
    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile("shared/gliaclaw", "custom.json", "secret", "/opt/custom.json");

    expect(mgr.listSharedVaults()).toEqual(["another", "gliaclaw"]);
    expect(mgr.deleteSharedVault("gliaclaw")).toBe(true);
    expect(existsSync(join(vaultsDir, "shared", "gliaclaw"))).toBe(false);
    expect(existsSync(join(tmpDir, "vault-mount-targets", "shared", "gliaclaw.json"))).toBe(false);
  });

  test("upsertFile writes private credential files and persists mount metadata", () => {
    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile(
      "U123",
      "custom.json",
      '{\n  "type": "authorized_user"\n}\n',
      "/opt/provider/credentials.json",
    );

    const credentialPath = join(vaultsDir, "U123", "custom.json");
    const metadataPath = join(tmpDir, "vault-mount-targets", "U123.json");
    expect(readFileSync(credentialPath, "utf-8")).toBe('{\n  "type": "authorized_user"\n}\n');
    expect(mode(credentialPath) & 0o077).toBe(0);
    expect(mode(metadataPath) & 0o077).toBe(0);
    expect(existsSync(join(vaultsDir, "U123", ".mount-targets.json"))).toBe(false);
    expect(new FileVaultManager(tmpDir).resolve("U123")?.mounts).toEqual([
      { source: credentialPath, target: "/opt/provider/credentials.json" },
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

  test("uses a nested explicit target without mounting its parent directory", () => {
    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile("U123", "nested/custom.json", "custom", "/opt/provider/custom.json");
    mgr.upsertFile("U123", "nested/sibling.json", "sibling");

    const mounts = mgr.resolve("U123")?.mounts;
    expect(mounts).toEqual(
      expect.arrayContaining([
        {
          source: join(vaultsDir, "U123", "nested", "custom.json"),
          target: "/opt/provider/custom.json",
        },
        {
          source: join(vaultsDir, "U123", "nested", "sibling.json"),
          target: "/root/nested/sibling.json",
        },
      ]),
    );
    expect(mounts).not.toContainEqual({
      source: join(vaultsDir, "U123", "nested"),
      target: "/root/nested",
    });
  });

  test.each(["legacy secret", '{"custom.json":"/opt/provider/custom.json"}'])(
    "fails closed on a legacy root mount metadata filename collision",
    (content) => {
      const dir = join(vaultsDir, "U123");
      const collisionPath = join(dir, ".mount-targets.json");
      mkdirSync(dir, { recursive: true });
      writeFileSync(collisionPath, content);
      const mgr = new FileVaultManager(tmpDir);

      expect(() => mgr.resolve("U123")).toThrow(/reserved mount metadata filename collision/);
      expect(readFileSync(collisionPath, "utf-8")).toBe(content);
      expect(existsSync(join(tmpDir, "vault-mount-targets", "U123.json"))).toBe(false);
    },
  );

  test("upsertFile rejects traversal and absolute relative paths", () => {
    const mgr = new FileVaultManager(tmpDir);
    const outsidePath = join(tmpDir, "escape.json");

    for (const relativePath of [
      "../escape.json",
      "..",
      ".",
      "/etc/passwd",
      ".mount-targets.json",
      "   ",
    ]) {
      expect(() => mgr.upsertFile("U123", relativePath, "secret")).toThrow(
        "vault: invalid relative secret file path",
      );
    }
    expect(existsSync(outsidePath)).toBe(false);
    expect(existsSync(join(vaultsDir, "U123"))).toBe(false);
  });

  test("upsertFile rejects a non-absolute mount target path", () => {
    const mgr = new FileVaultManager(tmpDir);

    expect(() => mgr.upsertFile("U123", "creds.json", "{}", "relative/target")).toThrow(
      "vault: invalid relative secret file path",
    );
    expect(existsSync(join(vaultsDir, "U123", "creds.json"))).toBe(false);
  });

  test("upsertFile atomically replaces existing mounted credential files", () => {
    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile("U123", "gws.json", "old", "/opt/provider/old.json");
    const credentialPath = join(vaultsDir, "U123", "gws.json");

    mgr.upsertFile("U123", "gws.json", "new", "/opt/provider/new.json");

    expect(readFileSync(credentialPath, "utf-8")).toBe("new");
    expect(mode(credentialPath) & 0o077).toBe(0);
    expect(mgr.resolve("U123")?.mounts).toEqual([
      { source: credentialPath, target: "/opt/provider/new.json" },
    ]);
  });

  test("upsertFile without a target removes an earlier explicit mount target", () => {
    const mgr = new FileVaultManager(tmpDir);
    mgr.upsertFile("U123", "gws.json", "old", "/opt/provider/credentials.json");

    mgr.upsertFile("U123", "gws.json", "new");

    expect(mgr.resolve("U123")?.mounts).toEqual([
      {
        source: join(vaultsDir, "U123", "gws.json"),
        target: "/root/.config/gws/credentials.json",
      },
    ]);
    expect(existsSync(join(tmpDir, "vault-mount-targets", "U123.json"))).toBe(false);
  });
});

describe("ActorExecutionResolver image mode", () => {
  let tmpDir: string;
  let vaultsDir: string;

  const workspace = () => createWorkspace({ root: tmpDir, stateDir: tmpDir });

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
      workspace(),
    );

    const decision = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });

    expect(decision.executor.getSandboxConfig()).toEqual({
      type: "container",
      container: `mikan-sandbox-${D123_OFFICE}`,
    });
    expect(mgr.resolve(DockerContainerManager.sanitizeSegment("D123"))).toBeUndefined();
  });

  test("a retired defaultSharedVault setting is ignored", async () => {
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
      workspace(),
    );
    const decision = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });

    expect(decision.executor.getSandboxConfig()).toEqual({
      type: "container",
      container: `mikan-sandbox-${D123_OFFICE}`,
    });
    expect(existsSync(join(vaultsDir, officeKey(createOfficeAddress("slack", "D123"))))).toBe(
      false,
    );
  });

  test("a retired defaultSharedVault never overwrites an existing image sandbox vault", async () => {
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
      workspace(),
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

    const resolver = new ActorExecutionResolver(baseConfig, mgr, undefined, workspace());
    const decision = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });

    expect(vaultKey).toBe(officeKey(createOfficeAddress("slack", "D123")));
    expect(decision.executor.getSandboxConfig()).toEqual({
      type: "container",
      container: `mikan-sandbox-${D123_OFFICE}`,
    });
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
    const provision = vi.fn().mockResolvedValue(`mikan-sandbox-${D123_OFFICE}`);
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      { provision } as any,
      workspace(),
    );

    const decision = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });
    await decision.executor.exec("pwd");

    expect(provision).toHaveBeenCalledWith(D123_OFFICE, {
      containerName: `mikan-sandbox-${D123_OFFICE}`,
      conversationId: "D123",
      mounts: [
        { source: join(tmpDir, D123_OFFICE), target: `/workspace/${D123_OFFICE}` },
        { source: join(tmpDir, "MEMORY.md"), target: "/workspace/MEMORY.md", readOnly: true },
        { source: join(tmpDir, "skills"), target: "/workspace/skills", readOnly: true },
        { source: join(vaultsDir, vaultKey, ".ssh"), target: "/root/.ssh" },
      ],
    });
    expect(exec).toHaveBeenCalledWith(
      `docker exec -w /workspace mikan-sandbox-${D123_OFFICE} sh -c 'pwd'`,
      undefined,
    );
  });

  test("a retired full override still gets the uniform office mounts", async () => {
    mkdirSync(join(tmpDir, D123_OFFICE), { recursive: true });
    writeFileSync(
      join(tmpDir, D123_OFFICE, "settings.json"),
      JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }) + "\n",
    );

    const mgr = new FileVaultManager(tmpDir);
    const provision = vi.fn().mockResolvedValue(`mikan-sandbox-${D123_OFFICE}`);
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const resolver = new ActorExecutionResolver(
      { type: "image", image: "ubuntu:24.04" },
      mgr,
      { provision } as any,
      workspace(),
    );

    const decision = await resolver.resolve({
      userId: "U123",
      address: createOfficeAddress("slack", "D123"),
    });
    await decision.executor.exec("pwd");

    expect(provision).toHaveBeenCalledWith(D123_OFFICE, {
      containerName: `mikan-sandbox-${D123_OFFICE}`,
      conversationId: "D123",
      mounts: [
        { source: join(tmpDir, D123_OFFICE), target: `/workspace/${D123_OFFICE}` },
        { source: join(tmpDir, "MEMORY.md"), target: "/workspace/MEMORY.md", readOnly: true },
        { source: join(tmpDir, "skills"), target: "/workspace/skills", readOnly: true },
      ],
    });
    expect(exec).toHaveBeenCalledWith(
      `docker exec -w /workspace mikan-sandbox-${D123_OFFICE} sh -c 'pwd'`,
      undefined,
    );
  });
});
