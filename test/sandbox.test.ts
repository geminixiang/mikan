import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ContainerExecutor,
  FirecrackerExecutor,
  HostExecutor,
  GondolinExecutor,
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

  test("parses the default gondolin profile", () => {
    expect(parseSandboxArg("gondolin:default")).toEqual({
      type: "gondolin",
      profile: "default",
    });
  });

  test("rejects the removed remote gondolin profile", () => {
    expect(() => parseSandboxArg("gondolin:remote")).toThrow(
      "Error: unsupported gondolin profile 'remote'. Use 'gondolin:default'",
    );
  });

  test("rejects unsupported gondolin profiles", () => {
    expect(() => parseSandboxArg("gondolin:custom")).toThrow(
      "Error: unsupported gondolin profile 'custom'. Use 'gondolin:default'",
    );
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

  test("rejects cloudflare with migration guidance", () => {
    // Remote execution is a task executor, not a sandbox runtime (ADR 0002).
    expect(() => parseSandboxArg("cloudflare:slack-u123")).toThrow(/no longer a sandbox mode/);
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

  test("creates a gondolin executor without starting Gondolin", () => {
    const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
    Object.defineProperty(process.versions, "node", { value: "24.0.0", configurable: true });
    try {
      expect(createExecutor({ type: "gondolin", profile: "default" })).toBeInstanceOf(
        GondolinExecutor,
      );
    } finally {
      if (nodeVersion) Object.defineProperty(process.versions, "node", nodeVersion);
    }
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
