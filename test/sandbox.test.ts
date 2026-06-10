import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CloudflareSandboxExecutor,
  ContainerExecutor,
  FirecrackerExecutor,
  HostExecutor,
  SandboxError,
  createExecutor,
  getSandboxProvider,
  getSandboxProviders,
  parseSandboxArg,
  resolveActorScopeKey,
} from "../src/sandbox/index.js";
import { pushVaultFileMounts } from "../src/sandbox/secret-injection.js";

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

    const [[dockerCommand, hostOptions]] = exec.mock.calls;
    expect(dockerCommand).toContain("docker exec -e GH_TOKEN -w /workspace");
    expect(dockerCommand).toContain("mikan-sandbox sh -c");
    expect(dockerCommand).toContain("gh auth setup-git");
    expect(dockerCommand).toContain("git clone https://github.com/livingbio/skills.git");
    expect(dockerCommand).not.toContain("gho_test");
    expect(hostOptions).toEqual({ env: { GH_TOKEN: "gho_test" } });
  });

  test("rejects unsafe environment variable names", async () => {
    vi.spyOn(HostExecutor.prototype, "exec").mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
    });
    const executor = new ContainerExecutor("mikan-sandbox", { "BAD KEY": "x" }, async () => {});

    await expect(executor.exec("pwd")).rejects.toThrowError(SandboxError);
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

    const executor = new CloudflareSandboxExecutor("slack-u123");
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
    });
  });

  test("pushes vault env once via the bridge session instead of per exec", async () => {
    process.env.MIKAN_CLOUDFLARE_SANDBOX_URL = "https://sandbox.example";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ stdout: "ok\n", stderr: "", code: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const executor = new CloudflareSandboxExecutor("slack-u123", { API_TOKEN: "secret" });
    await executor.exec("pwd");
    await executor.exec("ls");

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      path: (url as URL).pathname,
      body: JSON.parse(init.body),
    }));
    expect(calls.map((call) => call.path)).toEqual(["/env", "/exec", "/exec"]);
    expect(calls[0].body).toEqual({ sandboxId: "slack-u123", env: { API_TOKEN: "secret" } });
    expect(calls[1].body.env).toBeUndefined();
    expect(calls[2].body.env).toBeUndefined();
  });

  test("falls back to per-exec env injection for legacy bridges without /env", async () => {
    process.env.MIKAN_CLOUDFLARE_SANDBOX_URL = "https://sandbox.example";
    const fetchMock = vi.fn().mockImplementation(async (url: URL) => {
      if (url.pathname === "/env") {
        return { ok: false, status: 404, text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ stdout: "", stderr: "", code: 0 }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const executor = new CloudflareSandboxExecutor("slack-u123", { API_TOKEN: "secret" });
    await executor.exec("pwd");

    const execCall = fetchMock.mock.calls.find(([url]) => (url as URL).pathname === "/exec");
    expect(JSON.parse(execCall![1].body).env).toEqual({ API_TOKEN: "secret" });
  });

  test("writes credential files through the bridge fs API with private mode", async () => {
    process.env.MIKAN_CLOUDFLARE_SANDBOX_URL = "https://sandbox.example";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const executor = new CloudflareSandboxExecutor("slack-u123");
    await executor.fs.mkdir("/root/.config/gh");
    await executor.fs.writeFile("/root/.config/gh/hosts.yml", "github.com:\n");

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      path: (url as URL).pathname,
      body: JSON.parse(init.body),
    }));
    expect(calls[0]).toEqual({
      path: "/mkdir",
      body: { sandboxId: "slack-u123", path: "/root/.config/gh" },
    });
    expect(calls[1]).toEqual({
      path: "/write-file",
      body: {
        sandboxId: "slack-u123",
        path: "/root/.config/gh/hosts.yml",
        content: "github.com:\n",
        mode: "600",
      },
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

describe("sandbox provider capabilities", () => {
  test("declares capabilities for every builtin provider", () => {
    const byType = Object.fromEntries(
      getSandboxProviders().map((provider) => [provider.type, provider.capabilities]),
    );
    expect(byType).toEqual({
      host: {
        lifecycle: "external",
        credentialScope: "user",
        envInjection: "none",
        fileMounts: false,
        filePush: false,
      },
      container: {
        lifecycle: "external",
        credentialScope: "instance",
        envInjection: "per-exec",
        fileMounts: false,
        filePush: false,
      },
      image: {
        lifecycle: "managed",
        credentialScope: "conversation",
        envInjection: "per-exec",
        fileMounts: true,
        filePush: false,
      },
      firecracker: {
        lifecycle: "external",
        credentialScope: "conversation",
        envInjection: "per-exec",
        fileMounts: false,
        filePush: false,
      },
      cloudflare: {
        lifecycle: "managed",
        credentialScope: "conversation",
        envInjection: "at-create",
        fileMounts: false,
        filePush: true,
      },
    });
  });
});

describe("resolveActorScopeKey", () => {
  test("scopes host credentials to the user", () => {
    expect(resolveActorScopeKey({ type: "host" }, "U123", "D123")).toBe("U123");
  });

  test("scopes shared-container credentials to the container", () => {
    expect(
      resolveActorScopeKey({ type: "container", container: "mikan-tools" }, "U123", "D123"),
    ).toBe("container-mikan-tools");
  });

  test("scopes managed sandbox credentials to the conversation", () => {
    expect(resolveActorScopeKey({ type: "image", image: "ubuntu:24.04" }, "U123", "D123")).toBe(
      "d123",
    );
    expect(
      resolveActorScopeKey({ type: "cloudflare", sandboxId: "mikan-remote" }, "U123", "D123"),
    ).toBe("d123");
    expect(
      resolveActorScopeKey(
        { type: "firecracker", vmId: "vm1", hostPath: "/srv/ws" },
        "U123",
        "D 12/3!",
      ),
    ).toBe("d-12-3");
  });
});

describe("provider acquire", () => {
  test("cloudflare derives a per-scope sandbox id", async () => {
    const provider = getSandboxProvider("cloudflare");
    const instance = await provider.acquire(
      { type: "cloudflare", sandboxId: "mikan-remote" },
      { userId: "U123", conversationId: "D123", scopeKey: "alice" },
    );

    expect(instance.id).toBe("mikan-remote-alice");
    expect(instance.getSandboxConfig()).toEqual({
      type: "cloudflare",
      sandboxId: "mikan-remote-alice",
    });
  });

  test("image acquires a managed per-scope container instance", async () => {
    const provider = getSandboxProvider("image");
    const instance = await provider.acquire(
      { type: "image", image: "ubuntu:24.04" },
      { userId: "U123", conversationId: "D123", scopeKey: "d123" },
    );

    expect(instance.id).toBe("mikan-sandbox-d123");
    expect(instance.getSandboxConfig()).toEqual({
      type: "container",
      container: "mikan-sandbox-d123",
    });
  });

  test("image cannot be attached without actor context", () => {
    expect(() =>
      getSandboxProvider("image").attach({ type: "image", image: "ubuntu:24.04" }),
    ).toThrowError(SandboxError);
  });
});

describe("pushVaultFileMounts", () => {
  test("projects vault files and directories through the instance fs API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mikan-push-test-"));
    try {
      writeFileSync(join(dir, "gws.json"), '{"type":"authorized_user"}');
      mkdirSync(join(dir, "ssh"), { recursive: true });
      writeFileSync(join(dir, "ssh", "config"), "Host github.com\n");
      writeFileSync(join(dir, "ssh", "id_ed25519"), "PRIVATE\n");

      const written: Record<string, string> = {};
      const dirs: string[] = [];
      const instance = {
        id: "test",
        fs: {
          mkdir: async (path: string) => {
            dirs.push(path);
          },
          writeFile: async (path: string, content: string) => {
            written[path] = content;
          },
        },
        exec: async () => ({ stdout: "", stderr: "", code: 0 }),
        getWorkspacePath: () => "/workspace",
        getPathContext: () => ({ hostWorkspaceRoot: "/", runtimeWorkspaceRoot: "/workspace" }),
        getSandboxConfig: () => ({ type: "host" }) as const,
      };

      const pushed = await pushVaultFileMounts(instance, [
        { source: join(dir, "gws.json"), target: "/root/.config/gws/credentials.json" },
        { source: join(dir, "ssh"), target: "/root/.ssh" },
      ]);

      expect(pushed).toBe(3);
      expect(written).toEqual({
        "/root/.config/gws/credentials.json": '{"type":"authorized_user"}',
        "/root/.ssh/config": "Host github.com\n",
        "/root/.ssh/id_ed25519": "PRIVATE\n",
      });
      expect(dirs).toEqual(["/root/.config/gws", "/root/.ssh"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
