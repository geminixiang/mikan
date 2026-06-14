import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CloudflareSandboxExecutor,
  ContainerExecutor,
  FirecrackerExecutor,
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

  test("parses firecracker sandbox with defaults", () => {
    expect(parseSandboxArg("firecracker:172.16.0.2:/home/user/workspace")).toEqual({
      type: "firecracker",
      vmId: "172.16.0.2",
      hostPath: "/home/user/workspace",
      sshUser: "root",
      sshPort: 22,
    });
  });

  test("parses firecracker sandbox with custom SSH user and port", () => {
    expect(parseSandboxArg("firecracker:vm1:/srv/workspace:ubuntu:2222")).toEqual({
      type: "firecracker",
      vmId: "vm1",
      hostPath: "/srv/workspace",
      sshUser: "ubuntu",
      sshPort: 2222,
    });
  });

  test("parses cloudflare sandbox", () => {
    expect(parseSandboxArg("cloudflare:slack-u123")).toEqual({
      type: "cloudflare",
      sandboxId: "slack-u123",
    });
  });

  test("rejects invalid firecracker SSH port", () => {
    expect(() => parseSandboxArg("firecracker:vm1:/srv/workspace:root:99999")).toThrowError(
      SandboxError,
    );
    expect(() => parseSandboxArg("firecracker:vm1:/srv/workspace:root:99999")).toThrow(
      "Error: invalid SSH port",
    );
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

  test("creates firecracker executor", () => {
    expect(
      createExecutor({
        type: "firecracker",
        vmId: "172.16.0.2",
        hostPath: "/home/user/workspace",
      }),
    ).toBeInstanceOf(FirecrackerExecutor);
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

  test("injects GitHub token only for gh cli commands", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const executor = new ContainerExecutor(
      "mikan-sandbox",
      { GH_TOKEN: "gho_test", API_TOKEN: "secret" },
      async () => {},
    );

    await executor.exec("gh repo view livingbio/skills");

    const [[dockerCommand]] = exec.mock.calls;
    expect(dockerCommand).toContain("docker exec -e 'GH_TOKEN=gho_test' ");
    expect(dockerCommand).not.toContain("API_TOKEN");
    expect(dockerCommand).toContain("mikan-sandbox sh -c");
    expect(dockerCommand).toContain("gh repo view livingbio/skills");
  });

  test("injects Cloudflare env for npx wrangler commands", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const executor = new ContainerExecutor(
      "mikan-sandbox",
      { GH_TOKEN: "gho_test", CLOUDFLARE_API_TOKEN: "cf_test", CLOUDFLARE_ACCOUNT_ID: "acct" },
      async () => {},
    );

    await executor.exec("npx wrangler deploy");

    const [[dockerCommand]] = exec.mock.calls;
    expect(dockerCommand).toContain("CLOUDFLARE_API_TOKEN=cf_test");
    expect(dockerCommand).toContain("CLOUDFLARE_ACCOUNT_ID=acct");
    expect(dockerCommand).not.toContain("GH_TOKEN");
  });

  test("does not inject vault env for unrelated commands", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const executor = new ContainerExecutor(
      "mikan-sandbox",
      { GH_TOKEN: "gho_test", API_TOKEN: "secret" },
      async () => {},
    );

    await executor.exec("env");

    const [[dockerCommand]] = exec.mock.calls;
    expect(dockerCommand).not.toContain("--env-file");
    expect(dockerCommand).not.toContain("GH_TOKEN");
    expect(dockerCommand).not.toContain("API_TOKEN");
  });
});

describe("FirecrackerExecutor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("uses /workspace as the guest workspace path", () => {
    const executor = new FirecrackerExecutor("172.16.0.2", "/home/user/workspace");
    expect(executor.getWorkspacePath("/home/user/workspace")).toBe("/workspace");
  });

  test("executes commands through SSH with the default port", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "ok\n", stderr: "", code: 0 });
    const executor = new FirecrackerExecutor("172.16.0.2", "/home/user/workspace");

    await expect(executor.exec("echo 'hello'")).resolves.toEqual({
      stdout: "ok\n",
      stderr: "",
      code: 0,
    });

    expect(exec).toHaveBeenCalledWith(
      "ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@172.16.0.2 sh -c 'echo '\\''hello'\\'''",
      undefined,
    );
  });

  test("executes commands through SSH with a custom user and port", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const executor = new FirecrackerExecutor("vm1", "/srv/workspace", "ubuntu", 2222);

    await executor.exec("pwd", { timeout: 5 });

    expect(exec).toHaveBeenCalledWith(
      "ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p 2222 ubuntu@vm1 sh -c 'pwd'",
      { timeout: 5 },
    );
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

    const executor = new CloudflareSandboxExecutor("slack-u123", {
      CLOUDFLARE_API_TOKEN: "secret",
    });
    await expect(executor.exec("wrangler whoami", { timeout: 5 })).resolves.toEqual({
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
      command: "wrangler whoami",
      timeoutSeconds: 5,
      cwd: "/workspace",
      env: { CLOUDFLARE_API_TOKEN: "secret" },
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
