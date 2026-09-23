import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as log from "../log.js";
import {
  CloudflareSandboxExecutor,
  ContainerExecutor,
  HostExecutor,
  SandboxError,
  assertSandboxSupportsWorkspacePolicy,
  createExecutor,
  parseSandboxArg,
} from "../sandbox/index.js";

describe("parseSandboxArg", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("parses host sandbox", () => {
    expect(parseSandboxArg("host")).toEqual({ type: "host" });
  });

  test("parses container sandbox", () => {
    expect(parseSandboxArg("container:mikan-sandbox")).toEqual({
      type: "container",
      container: "mikan-sandbox",
    });
  });

  test("parses image sandbox for managed per-user containers", () => {
    expect(parseSandboxArg("image:ubuntu:24.04")).toEqual({
      type: "image",
      image: "ubuntu:24.04",
    });
  });

  test("removed backends are rejected as invalid sandbox types", () => {
    expect(() => parseSandboxArg("gondolin:default")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("firecracker:vm1:/srv/workspace")).toThrowError(SandboxError);
  });

  test("parses cloudflare sandbox", () => {
    expect(parseSandboxArg("cloudflare:slack-u123")).toEqual({
      type: "cloudflare",
      sandboxId: "slack-u123",
    });
  });

  test("rejects unsupported sandbox type", () => {
    expect(() => parseSandboxArg("podman:mikan")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("podman:mikan")).toThrow(
      "Error: Invalid sandbox type 'podman:mikan'",
    );
  });

  test("rejects docker mode with migration hint", () => {
    expect(() => parseSandboxArg("docker:mikan-sandbox")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("docker:mikan-sandbox")).toThrow(
      "Use 'container:<container-name>' for the shared-container mode",
    );
  });
});

describe("assertSandboxSupportsWorkspacePolicy", () => {
  test.each([
    { type: "host" } as const,
    { type: "container", container: "mikan-sandbox" } as const,
    { type: "cloudflare", sandboxId: "mikan-remote" } as const,
  ])("warns once about an unenforced private office on $type", (sandboxConfig) => {
    const warn = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    const key = `k-${sandboxConfig.type}`;
    assertSandboxSupportsWorkspacePolicy(sandboxConfig, "private", key);
    assertSandboxSupportsWorkspacePolicy(sandboxConfig, "private", key);
    assertSandboxSupportsWorkspacePolicy(sandboxConfig, "public", key);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/cannot enforce private office visibility/);
    warn.mockRestore();
  });

  test("image mode enforces visibility silently", () => {
    const warn = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    assertSandboxSupportsWorkspacePolicy({ type: "image", image: "ubuntu:24.04" }, "private", "k");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("createExecutor", () => {
  test("creates host executor", () => {
    expect(createExecutor({ type: "host" })).toBeInstanceOf(HostExecutor);
  });

  test("creates container executor", () => {
    expect(createExecutor({ type: "container", container: "mikan-sandbox" })).toBeInstanceOf(
      ContainerExecutor,
    );
  });

  test("rejects unresolved image executor", () => {
    expect(() => createExecutor({ type: "image", image: "ubuntu:24.04" })).toThrowError(
      SandboxError,
    );
  });

  test("creates cloudflare executor", () => {
    expect(createExecutor({ type: "cloudflare", sandboxId: "shared-prefix" })).toBeInstanceOf(
      CloudflareSandboxExecutor,
    );
  });
});

describe("ContainerExecutor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("applies guest cwd only to docker, preserving host timeout and cancellation", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const executor = new ContainerExecutor("mikan-sandbox", undefined, async () => {});
    const signal = new AbortController().signal;

    await executor.exec("pwd", { cwd: "/guest-only/work space", timeout: 5, signal });

    expect(exec).toHaveBeenCalledWith(expect.stringContaining("-w '/guest-only/work space'"), {
      timeout: 5,
      signal,
    });
  });

  test("configures the gh git credential helper through env without writing git config", async () => {
    let envFile = "";
    vi.spyOn(HostExecutor.prototype, "exec").mockImplementation(async (command) => {
      const path = /--env-file '([^']+)'/.exec(command)?.[1];
      envFile = path ? readFileSync(path, "utf8") : "";
      return { stdout: "", stderr: "", code: 0 };
    });
    const executor = new ContainerExecutor(
      "mikan-sandbox",
      { GH_TOKEN: "gho_test" },
      async () => {},
    );

    await executor.exec("git clone https://github.com/livingbio/skills.git");

    expect(envFile.split("\n")).toEqual([
      "GH_TOKEN=gho_test",
      "GIT_CONFIG_COUNT=2",
      "GIT_CONFIG_KEY_0=credential.https://github.com.helper",
      "GIT_CONFIG_VALUE_0=",
      "GIT_CONFIG_KEY_1=credential.https://github.com.helper",
      "GIT_CONFIG_VALUE_1=!gh auth git-credential",
      "",
    ]);
  });

  test("leaves env untouched without a GitHub token", async () => {
    let envFile = "";
    vi.spyOn(HostExecutor.prototype, "exec").mockImplementation(async (command) => {
      const path = /--env-file '([^']+)'/.exec(command)?.[1];
      envFile = path ? readFileSync(path, "utf8") : "";
      return { stdout: "", stderr: "", code: 0 };
    });
    const executor = new ContainerExecutor("mikan-sandbox", { FOO: "bar" }, async () => {});

    await executor.exec("true");

    expect(envFile).toBe("FOO=bar\n");
  });
});

describe("CloudflareSandboxExecutor", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test("posts exec requests to the bridge", async () => {
    process.env.MIKAN_CLOUDFLARE_SANDBOX_URL = "https://sandbox.example";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ stdout: "ok\n", stderr: "", code: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const executor = new CloudflareSandboxExecutor("slack-u123", { API_TOKEN: "secret" });
    await expect(executor.exec("pwd", { timeout: 5 })).resolves.toEqual({
      stdout: "ok\n",
      stderr: "",
      code: 0,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/exec", "https://sandbox.example"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "content-type": "application/json" }),
      }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      sandboxId: "slack-u123",
      command: "pwd",
      timeoutSeconds: 5,
      cwd: "/workspace",
      env: { API_TOKEN: "secret" },
    });
  });
});
