import { describe, expect, test, vi } from "vitest";
import { DockerContainerManager } from "../src/sandbox/providers/docker/provisioner.js";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("DockerContainerManager", () => {
  test("re-checks a cached container and starts it when it was stopped", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValueOnce({ stdout: "false\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValueOnce({ stdout: "started\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await manager.provision("slack-u123");
    await manager.provision("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(1, "docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      "mikan-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(2, "docker", [
      "inspect",
      "-f",
      "{{json .HostConfig.Binds}}",
      "mikan-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(3, "docker", [
      "inspect",
      "-f",
      "{{.HostConfig.NetworkMode}}",
      "mikan-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(4, "docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      "mikan-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(5, "docker", [
      "inspect",
      "-f",
      "{{json .HostConfig.Binds}}",
      "mikan-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(6, "docker", [
      "inspect",
      "-f",
      "{{.HostConfig.NetworkMode}}",
      "mikan-sandbox-slack-u123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(7, "docker", ["start", "mikan-sandbox-slack-u123"]);
  });

  test("re-checks a cached container and recreates it when it was deleted", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await manager.provision("slack-u123");
    await manager.provision("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(6, "docker", [
      "run",
      "-d",
      "--name",
      "mikan-sandbox-slack-u123",
      "--network",
      "mikan-sandbox-net-slack-u123",
      "--label",
      "mikan.managed=true",
      "--label",
      "mikan.sandbox=image",
      "--label",
      "mikan.vault-id=slack-u123",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
  });

  test("provisions custom container names with extra vault mounts", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockRejectedValueOnce(new Error("No such network"))
      .mockResolvedValueOnce({ stdout: "network-id\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" })
      .mockResolvedValueOnce({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await manager.provision("alice", {
      containerName: "alice-box",
      mounts: [{ source: "/tmp/vaults/alice/.ssh", target: "/root/.ssh" }],
      conversationId: "D123",
    });
    await manager.stop("alice");

    expect(execMock).toHaveBeenNthCalledWith(3, "docker", [
      "network",
      "create",
      "--driver",
      "bridge",
      "--label",
      "mikan.managed=true",
      "--label",
      "mikan.sandbox=image",
      "--label",
      "mikan.vault-id=alice",
      "mikan-sandbox-net-alice",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(4, "docker", [
      "run",
      "-d",
      "--name",
      "alice-box",
      "--network",
      "mikan-sandbox-net-alice",
      "--label",
      "mikan.managed=true",
      "--label",
      "mikan.sandbox=image",
      "--label",
      "mikan.vault-id=alice",
      "--label",
      "mikan.conversation-id=D123",
      "--label",
      expect.stringMatching(/^mikan\.mount-signature=[a-f0-9]{64}$/),
      "-v",
      "/tmp/vaults/alice/.ssh:/root/.ssh",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(5, "docker", ["stop", "alice-box"]);
  });

  test("creates the network when docker reports '<name> not found'", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockRejectedValueOnce(
        new Error(
          "Error response from daemon: network mikan-sandbox-net-slack-u123-d123 not found",
        ),
      )
      .mockResolvedValueOnce({ stdout: "network-id\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await manager.provision("slack-u123-d123", {
      conversationId: "D123",
    });

    expect(execMock).toHaveBeenNthCalledWith(2, "docker", [
      "network",
      "inspect",
      "mikan-sandbox-net-slack-u123-d123",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(3, "docker", [
      "network",
      "create",
      "--driver",
      "bridge",
      "--label",
      "mikan.managed=true",
      "--label",
      "mikan.sandbox=image",
      "--label",
      "mikan.vault-id=slack-u123-d123",
      "mikan-sandbox-net-slack-u123-d123",
    ]);
  });

  test("recreates existing containers when vault mounts change", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({
        stdout: '["/tmp/vaults/alice/.ssh:/root/.ssh"]\n',
      })
      .mockResolvedValueOnce({ stdout: "removed\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await manager.provision("alice", {
      containerName: "alice-box",
      mounts: [{ source: "/tmp/vaults/alice/.kube", target: "/root/.kube" }],
      conversationId: "D123",
    });

    expect(execMock).toHaveBeenNthCalledWith(3, "docker", ["rm", "-f", "alice-box"]);
    expect(execMock).toHaveBeenNthCalledWith(5, "docker", [
      "run",
      "-d",
      "--name",
      "alice-box",
      "--network",
      "mikan-sandbox-net-alice",
      "--label",
      "mikan.managed=true",
      "--label",
      "mikan.sandbox=image",
      "--label",
      "mikan.vault-id=alice",
      "--label",
      "mikan.conversation-id=D123",
      "--label",
      expect.stringMatching(/^mikan\.mount-signature=[a-f0-9]{64}$/),
      "-v",
      "/tmp/vaults/alice/.kube:/root/.kube",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
  });

  test("recreates existing containers when network isolation is missing", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "bridge\n" })
      .mockResolvedValueOnce({ stdout: "removed\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await manager.provision("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(4, "docker", ["rm", "-f", "mikan-sandbox-slack-u123"]);
    expect(execMock).toHaveBeenNthCalledWith(6, "docker", [
      "run",
      "-d",
      "--name",
      "mikan-sandbox-slack-u123",
      "--network",
      "mikan-sandbox-net-slack-u123",
      "--label",
      "mikan.managed=true",
      "--label",
      "mikan.sandbox=image",
      "--label",
      "mikan.vault-id=slack-u123",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
  });

  test("stopIdle stops only containers idle longer than threshold", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u111\n" })
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u222\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await manager.provision("slack-u111");
    await manager.provision("slack-u222");

    const stateField = (manager as any).state as Map<string, { status: string; lastUsed: number }>;
    stateField.get("slack-u111")!.lastUsed = Date.now() - 7200000;

    execMock.mockResolvedValue({ stdout: "" });
    await manager.stopIdle(3600000);

    const stopCalls = execMock.mock.calls.filter((c) => c[0] === "docker" && c[1][0] === "stop");
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0][1]).toEqual(["stop", "mikan-sandbox-slack-u111"]);
  });

  test("reconcile discovers labeled containers and restores state", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-slack-u123-d123\n" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({
        stdout: "true\t2026-04-22T00:00:00.000000000Z\tslack-u123\tD123\n",
      });
    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await manager.reconcile();

    const stateField = (manager as any).state as Map<string, { status: string; lastUsed: number }>;
    expect(stateField.get("slack-u123-d123")?.status).toBe("running");
    expect(stateField.get("slack-u123-d123")?.lastUsed).toBe(
      Date.parse("2026-04-22T00:00:00.000Z"),
    );
  });

  test("reconcile removes legacy containers without conversation labels", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-slack-u123\n" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "true\t2026-04-22T00:00:00.000000000Z\tslack-u123\t\n" })
      .mockResolvedValueOnce({ stdout: "removed\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await manager.reconcile();

    expect(execMock).toHaveBeenNthCalledWith(4, "docker", ["rm", "-f", "mikan-sandbox-slack-u123"]);
    const stateField = (manager as any).state as Map<string, { status: string; lastUsed: number }>;
    expect(stateField.size).toBe(0);
  });

  test("concurrent provision calls for the same vaultId share one docker run", async () => {
    const startDeferred = createDeferred<{ stdout: string }>();
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockReturnValueOnce(startDeferred.promise);

    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    const first = manager.provision("slack-u123");
    const second = manager.provision("slack-u123");

    startDeferred.resolve({ stdout: "new-container-id\n" });
    await Promise.all([first, second]);

    expect(execMock).toHaveBeenCalledTimes(3);
    expect(execMock.mock.calls[0][1][0]).toBe("inspect");
    expect(execMock.mock.calls[2][1][0]).toBe("run");
  });

  test("failed docker start clears cached state and allows re-inspection", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "false\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockRejectedValueOnce(new Error("docker start failed"))
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "new-id\n" });

    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await expect(manager.provision("slack-u123")).rejects.toThrow(/start failed/);

    const stateField = (manager as any).state as Map<string, unknown>;
    expect(stateField.has("slack-u123")).toBe(false);

    await expect(manager.provision("slack-u123")).resolves.toBe("mikan-sandbox-slack-u123");
    expect(execMock.mock.calls[4][1][0]).toBe("inspect");
  });

  test("passes --cpus, --memory, and --memory-swap to docker run when limits are configured", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" })
      .mockResolvedValueOnce({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { cpus: "0.5", memory: "512m" },
      execFileImpl: execMock as any,
    });

    await manager.provision("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(3, "docker", [
      "run",
      "-d",
      "--name",
      "mikan-sandbox-slack-u123",
      "--network",
      "mikan-sandbox-net-slack-u123",
      "--label",
      "mikan.managed=true",
      "--label",
      "mikan.sandbox=image",
      "--label",
      "mikan.vault-id=slack-u123",
      "--cpus",
      "0.5",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(4, "docker", [
      "update",
      "--cpus",
      "0.5",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "mikan-sandbox-slack-u123",
    ]);
  });

  test("applies limits to already-running containers via docker update", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValueOnce({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { cpus: "1", memory: "1g" },
      execFileImpl: execMock as any,
    });

    await manager.provision("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(4, "docker", [
      "update",
      "--cpus",
      "1",
      "--memory",
      "1g",
      "--memory-swap",
      "1g",
      "mikan-sandbox-slack-u123",
    ]);
  });

  test("skips docker update when no limits configured", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await manager.provision("slack-u123");

    const updateCalls = execMock.mock.calls.filter((c) => c[1][0] === "update");
    expect(updateCalls).toHaveLength(0);
  });

  test("setLimits applies temporary limits to a running container", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValue({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { cpus: "0.5", memory: "1g" },
      execFileImpl: execMock as any,
    });

    await manager.provision("slack-u123");
    const status = await manager.setLimits("slack-u123", { cpus: "2", memory: "4g" });

    expect(status).toEqual({ limits: { cpus: "2", memory: "4g" }, boosted: false });
    expect(execMock.mock.calls.at(-1)).toEqual([
      "docker",
      [
        "update",
        "--cpus",
        "2",
        "--memory",
        "4g",
        "--memory-swap",
        "4g",
        "mikan-sandbox-slack-u123",
      ],
    ]);
  });

  test("setLimits affects the next docker run before a container exists", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" })
      .mockResolvedValueOnce({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { memory: "1g" },
      execFileImpl: execMock as any,
    });

    await manager.setLimits("slack-u123", { cpus: "2" });
    await manager.provision("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(3, "docker", [
      "run",
      "-d",
      "--name",
      "mikan-sandbox-slack-u123",
      "--network",
      "mikan-sandbox-net-slack-u123",
      "--label",
      "mikan.managed=true",
      "--label",
      "mikan.sandbox=image",
      "--label",
      "mikan.vault-id=slack-u123",
      "--cpus",
      "2",
      "--memory",
      "1g",
      "--memory-swap",
      "1g",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
  });

  test("boost applies boost limits to a running container", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValue({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { cpus: "0.5", memory: "1g" },
      boostLimits: { cpus: "2", memory: "4g" },
      execFileImpl: execMock as any,
    });

    await manager.provision("slack-u123");
    const status = await manager.boost("slack-u123");

    expect(status).toEqual({ limits: { cpus: "2", memory: "4g" }, boosted: true });
    expect(execMock.mock.calls.at(-1)).toEqual([
      "docker",
      [
        "update",
        "--cpus",
        "2",
        "--memory",
        "4g",
        "--memory-swap",
        "4g",
        "mikan-sandbox-slack-u123",
      ],
    ]);
  });

  test("stopping a container clears boost state", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValue({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { cpus: "0.5", memory: "1g" },
      boostLimits: { cpus: "2", memory: "4g" },
      execFileImpl: execMock as any,
    });

    await manager.provision("slack-u123");
    await manager.boost("slack-u123");
    await manager.stop("slack-u123");

    expect(manager.getLimitStatus("slack-u123")).toEqual({
      limits: { cpus: "0.5", memory: "1g" },
      boosted: false,
    });
  });

  test("provision succeeds even when docker update fails", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" })
      .mockRejectedValueOnce(new Error("docker update unsupported"));
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { memory: "256m" },
      execFileImpl: execMock as any,
    });

    await expect(manager.provision("slack-u123")).resolves.toBe("mikan-sandbox-slack-u123");
  });

  test("remove also deletes the per-vault network", async () => {
    const execMock = vi
      .fn<(file: string, args: string[]) => Promise<{ stdout: string; stderr?: string }>>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" })
      .mockResolvedValueOnce({ stdout: "removed\n" })
      .mockResolvedValueOnce({ stdout: "network removed\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", execMock as any);

    await manager.provision("slack-u123");
    await manager.remove("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(4, "docker", ["rm", "-f", "mikan-sandbox-slack-u123"]);
    expect(execMock).toHaveBeenNthCalledWith(5, "docker", [
      "network",
      "rm",
      "mikan-sandbox-net-slack-u123",
    ]);
  });
});
