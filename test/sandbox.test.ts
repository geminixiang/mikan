import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CloudflareSandboxExecutor,
  ContainerExecutor,
  HostExecutor,
  SandboxError,
  createExecutor,
  parseSandboxArg,
} from "../src/sandbox/index.js";

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

  test("parses agent sandbox warm pool", () => {
    expect(parseSandboxArg("agent-sandbox:mikan-kata")).toEqual({
      type: "agent-sandbox",
      warmpool: "mikan-kata",
      resourceKey: "default",
      mounts: [],
    });
  });

  test("rejects an empty agent sandbox warm pool", () => {
    expect(() => parseSandboxArg("agent-sandbox:")).toThrowError(SandboxError);
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

  test("creates agent sandbox executor without connecting", () => {
    const executor = createExecutor({
      type: "agent-sandbox",
      warmpool: "mikan-kata",
      resourceKey: "conversation-1",
      mounts: [],
    });
    expect(executor.getSandboxConfig().type).toBe("agent-sandbox");
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

  test("bootstraps git credential helper when GitHub token env is injected", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const executor = new ContainerExecutor(
      "mikan-sandbox",
      { GH_TOKEN: "gho_test" },
      async () => {},
    );

    await executor.exec("git clone https://github.com/livingbio/skills.git");

    const [[dockerCommand]] = exec.mock.calls;
    expect(dockerCommand).toContain("docker exec --env-file ");
    expect(dockerCommand).toContain("mikan-sandbox sh -c");
    expect(dockerCommand).toContain("gh auth setup-git");
    expect(dockerCommand).toContain("git clone https://github.com/livingbio/skills.git");
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

  test("reports the configured Cloudflare runtime cwd as workspace path", () => {
    process.env.MIKAN_CLOUDFLARE_SANDBOX_CWD = "/remote/workspace";
    const executor = new CloudflareSandboxExecutor("slack-u123");

    expect(executor.getWorkspacePath("/host/workspace")).toBe("/remote/workspace");
    expect(executor.getPathContext("/host/workspace")).toMatchObject({
      hostWorkspaceRoot: "/host/workspace",
      runtimeWorkspaceRoot: "/remote/workspace",
    });
    expect(executor.getPathContext("/host/workspace").runtimeToHostPath).toBeUndefined();
  });
});
