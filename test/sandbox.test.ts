import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CloudflareSandboxExecutor,
  ContainerExecutor,
  FirecrackerExecutor,
  GondolinSandboxExecutor,
  HostExecutor,
  SandboxError,
  createExecutor,
  parseSandboxArg,
} from "../src/sandbox/index.js";
import { startSecretInjectionProxy } from "../src/sandbox/proxy.js";

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

  test("parses gondolin sandbox", () => {
    expect(parseSandboxArg("gondolin:slack-u123")).toEqual({
      type: "gondolin",
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

  test("creates gondolin executor", () => {
    expect(createExecutor({ type: "gondolin", sandboxId: "shared-prefix" })).toBeInstanceOf(
      GondolinSandboxExecutor,
    );
  });
});

describe("ContainerExecutor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("does not inject vault env or file secrets into docker exec", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const executor = new ContainerExecutor(
      "mikan-sandbox",
      {
        env: { GH_TOKEN: "gho_test" },
        files: [{ source: "/host/adc.json", target: "/workspace/gcloud-adc.json" }],
      },
      async () => {},
    );

    await executor.exec("printf $GH_TOKEN && test -e /workspace/gcloud-adc.json");

    const [[dockerCommand]] = exec.mock.calls;
    expect(dockerCommand).not.toContain("--env-file");
    expect(dockerCommand).not.toContain("gho_test");
    expect(dockerCommand).not.toContain("mktemp -d /tmp/mikan-vault.");
    expect(dockerCommand).toContain("printf $GH_TOKEN && test -e /workspace/gcloud-adc.json");
  });

  test("enables secret header injection for HTTP proxy traffic only", async () => {
    const exec = vi
      .spyOn(HostExecutor.prototype, "exec")
      .mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    const executor = new ContainerExecutor(
      "mikan-sandbox",
      {
        env: {
          MIKAN_PROXY_INJECT_HEADERS: JSON.stringify({ "api.example": { authorization: "x" } }),
        },
      },
      async () => {},
    );

    await executor.exec("curl http://api.example/check");

    const [[dockerCommand]] = exec.mock.calls;
    expect(dockerCommand).toContain(
      'export HTTP_PROXY="http://127.0.0.1:$(cat "$proxy_dir/port")"',
    );
    expect(dockerCommand).toContain('export http_proxy="$HTTP_PROXY"');
    expect(dockerCommand).not.toContain("HTTPS_PROXY");
    expect(dockerCommand).not.toContain("ALL_PROXY");
  });
});

async function runProxyHeaderRequest(upstream: ReturnType<typeof createServer>): Promise<void> {
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const host = `127.0.0.1:${address.port}`;
  const proxy = await startSecretInjectionProxy({ [host]: { authorization: "Bearer injected" } });
  try {
    await new Promise<void>((resolve) => {
      const proxyUrl = new URL(proxy.url);
      const req = httpRequest(
        {
          hostname: proxyUrl.hostname,
          port: proxyUrl.port,
          method: "GET",
          path: `http://${host}/check`,
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.end();
    });
  } finally {
    await proxy.close();
  }
}

describe("Secret injection proxy", () => {
  test("injects configured headers into proxied HTTP requests", async () => {
    const seen = await new Promise<Record<string, string | string[] | undefined>>(
      (resolve, reject) => {
        const upstream = createServer((request, response) => {
          resolve(request.headers);
          response.end("ok");
        });
        upstream.listen(0, "127.0.0.1", () => {
          runProxyHeaderRequest(upstream)
            .catch(reject)
            .finally(() => upstream.close());
        });
      },
    );

    expect(seen.authorization).toBe("Bearer injected");
  });

  test("rejects HTTPS CONNECT because encrypted headers cannot be injected", async () => {
    const proxy = await startSecretInjectionProxy({ "example.com": { authorization: "Bearer x" } });
    try {
      const proxyUrl = new URL(proxy.url);
      const response = await new Promise<string>((resolve, reject) => {
        const socket = netConnect(Number(proxyUrl.port), proxyUrl.hostname, () => {
          socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
        });
        let data = "";
        socket.on("data", (chunk) => (data += chunk.toString("utf-8")));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });

      expect(response).toContain("501 Not Implemented");
      expect(response).toContain("supports HTTP proxy requests only");
    } finally {
      await proxy.close();
    }
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

describe("GondolinSandboxExecutor", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test("does not expose vault env secrets in bridge exec payload", async () => {
    process.env.MIKAN_GONDOLIN_SANDBOX_URL = "https://gondolin.example";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ stdout: "ok\n", stderr: "", code: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const executor = new GondolinSandboxExecutor("slack-u123", {
      env: { API_TOKEN: "secret" },
    });
    await expect(executor.exec("pwd", { timeout: 5 })).resolves.toEqual({
      stdout: "ok\n",
      stderr: "",
      code: 0,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/exec", "https://gondolin.example"),
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

  test("sends only proxy header rules to the bridge", async () => {
    process.env.MIKAN_GONDOLIN_SANDBOX_URL = "https://gondolin.example";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ stdout: "ok\n", stderr: "", code: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const proxyRules = JSON.stringify({ "api.example": { authorization: "Bearer injected" } });
    const executor = new GondolinSandboxExecutor("slack-u123", {
      env: { API_TOKEN: "secret", MIKAN_PROXY_INJECT_HEADERS: proxyRules },
    });
    await executor.exec("curl http://api.example/check");

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      sandboxId: "slack-u123",
      command: "curl http://api.example/check",
      cwd: "/workspace",
      secrets: { env: { MIKAN_PROXY_INJECT_HEADERS: proxyRules } },
    });
  });
});

describe("CloudflareSandboxExecutor", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  test("does not expose vault env secrets in bridge exec payload", async () => {
    process.env.MIKAN_CLOUDFLARE_SANDBOX_URL = "https://sandbox.example";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ stdout: "ok\n", stderr: "", code: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const executor = new CloudflareSandboxExecutor("slack-u123", { env: { API_TOKEN: "secret" } });
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

  test("sends only proxy header rules to the bridge", async () => {
    process.env.MIKAN_CLOUDFLARE_SANDBOX_URL = "https://sandbox.example";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ stdout: "ok\n", stderr: "", code: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const proxyRules = JSON.stringify({ "api.example": { authorization: "Bearer injected" } });
    const executor = new CloudflareSandboxExecutor("slack-u123", {
      env: { API_TOKEN: "secret", MIKAN_PROXY_INJECT_HEADERS: proxyRules },
    });
    await executor.exec("curl http://api.example/check");

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      sandboxId: "slack-u123",
      command: "curl http://api.example/check",
      cwd: "/workspace",
      secrets: { env: { MIKAN_PROXY_INJECT_HEADERS: proxyRules } },
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
