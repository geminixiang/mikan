import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi, type Mock } from "vitest";
import * as log from "../log.js";
import { DockerContainerManager } from "../sandbox/provisioner.js";
import { legacyConversationResourceKey } from "../sandbox/identity.js";
import type { DockerExecFile } from "../sandbox/types.js";

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

function routerMock(overrides: {
  status?: string;
  binds?: string[];
  imageBinds?: string[];
  names?: string[];
  imageRef?: string;
  images?: string[];
  networkMode?: string;
}) {
  const calls: string[][] = [];
  let created = false;
  const exec = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "create") created = true;
    const fmt = args[0] === "inspect" ? (args[2] ?? "") : "";
    if (args[0] === "inspect" && fmt.includes("State.Running")) {
      if (overrides.status === "missing" && !created) throw new Error("No such object");
      return { stdout: `${overrides.status === "running"}\n` };
    }
    if (args[0] === "inspect" && fmt.includes("HostConfig.Binds")) {
      return { stdout: `${JSON.stringify(overrides.binds ?? [])}\n` };
    }
    if (args[0] === "inspect" && fmt.includes("mikan.migrate-binds")) {
      if (overrides.imageBinds === undefined) throw new Error("No such image");
      return { stdout: `${JSON.stringify(overrides.imageBinds)}\n` };
    }
    if (args[0] === "inspect" && fmt.includes("Config.Image")) {
      const ref = created
        ? `mikan-migrate:${args[args.length - 1]}`
        : (overrides.imageRef ?? "base");
      return { stdout: `${ref}\n` };
    }
    if (args[0] === "inspect" && fmt.includes("NetworkMode")) {
      return { stdout: `${overrides.networkMode ?? "mikan-sandbox-net-c123-k"}\n` };
    }
    if (args[0] === "inspect" && fmt.includes("mount-signature")) {
      return { stdout: "<no value>\n" };
    }
    if (args[0] === "ps") {
      return { stdout: `${(overrides.names ?? []).join("\n")}\n` };
    }
    if (args[0] === "images") {
      const images = overrides.images ?? [];
      const lines = args.includes("{{.Tag}}")
        ? images.map((image) => image.slice(image.indexOf(":") + 1))
        : images;
      return { stdout: `${lines.join("\n")}\n` };
    }
    return { stdout: "ok\n" };
  });
  return { exec, calls };
}

const DOCKER_READS = new Set(["inspect", "ps", "images"]);

function stopCallsOf(exec: Mock<DockerExecFile>): string[][] {
  return exec.mock.calls.flatMap(([, args]) => (args[0] === "stop" ? [args] : []));
}

function dockerWrites(calls: string[][]): string[][] {
  return calls.filter((args) => !DOCKER_READS.has(args[0] ?? ""));
}

describe("DockerContainerManager", () => {
  describe("container layout migration", () => {
    const LEGACY_BINDS = [
      "/w/C123:/workspace/C123",
      "/state/vaults/c123-oldhash/.ssh:/root/.ssh",
      "/state/shared/data:/opt/shared/data:ro",
    ];
    const NEW_BINDS = [
      "/w/v1-slack-c123-k:/workspace/v1-slack-c123-k",
      "/state/vaults/v1-slack-c123-k/.ssh:/root/.ssh",
      "/state/shared/data:/opt/shared/data:ro",
    ];
    const translator = (spec: string): string => {
      const index = LEGACY_BINDS.indexOf(spec);
      if (index === -1) return spec;
      const translated = NEW_BINDS[index];
      if (translated === undefined) throw new Error(`no translated bind for ${spec}`);
      return translated;
    };

    test("moves a legacy container: commit with binds label, rm, create translated", async () => {
      const { exec, calls } = routerMock({
        status: "stopped",
        binds: LEGACY_BINDS,
        names: ["mikan-sandbox-c123-k"],
      });
      const manager = new DockerContainerManager("base", { execFileImpl: exec });
      manager.armContainerLayoutMigration(translator);

      await manager.sweepContainerLayoutMigration(0);

      const commit = calls.find((args) => args[0] === "commit");
      expect(commit?.[2]).toContain("mikan.migrate-binds=");
      expect(commit?.slice(-2)).toEqual([
        "mikan-sandbox-c123-k",
        "mikan-migrate:mikan-sandbox-c123-k",
      ]);
      expect(calls).toContainEqual(["rm", "-f", "mikan-sandbox-c123-k"]);
      const create = calls.find((args) => args[0] === "create");
      expect(create).toBeDefined();
      for (const bind of NEW_BINDS) expect(create).toContain(bind);
      for (const bind of [LEGACY_BINDS[0], LEGACY_BINDS[1]]) expect(create).not.toContain(bind);
      expect(create).toContain("mikan-migrate:mikan-sandbox-c123-k");
      expect(create?.some((arg) => arg.startsWith("mikan.mount-signature="))).toBe(true);
      expect(calls.find((args) => args[0] === "run")).toBeUndefined();
    });

    test("a container already on the office layout is untouched", async () => {
      const { exec, calls } = routerMock({
        status: "stopped",
        binds: NEW_BINDS,
        names: ["mikan-sandbox-c123-k"],
      });
      const manager = new DockerContainerManager("base", { execFileImpl: exec });
      manager.armContainerLayoutMigration(translator);

      await manager.sweepContainerLayoutMigration(0);

      expect(dockerWrites(calls)).toEqual([]);
    });

    test("resumes from the snapshot when the container vanished mid-migration", async () => {
      const { exec, calls } = routerMock({
        status: "missing",
        imageBinds: LEGACY_BINDS,
        names: ["mikan-sandbox-c123-k"],
      });
      const manager = new DockerContainerManager("base", { execFileImpl: exec });
      manager.armContainerLayoutMigration(translator);

      await manager.sweepContainerLayoutMigration(0);

      expect(calls.find((args) => args[0] === "commit")).toBeUndefined();
      const create = calls.find((args) => args[0] === "create");
      for (const bind of NEW_BINDS) expect(create).toContain(bind);
    });

    test("a container migrated once does not migrate again on a later sweep (regression: stayed pinned to its snapshot across every restart)", async () => {
      const { exec, calls } = routerMock({
        status: "missing",
        names: [],
        images: ["mikan-migrate:mikan-sandbox-c123-k"],
        imageBinds: LEGACY_BINDS,
      });
      const manager = new DockerContainerManager("base", { execFileImpl: exec });
      manager.armContainerLayoutMigration(translator);

      await manager.sweepContainerLayoutMigration(0);
      expect(calls.find((args) => args[0] === "create")).toBeDefined();
      expect(calls).toContainEqual(["rmi", "mikan-migrate:mikan-sandbox-c123-k"]);

      calls.length = 0;
      await manager.sweepContainerLayoutMigration(0);

      expect(calls.find((args) => args[0] === "create")).toBeUndefined();
      expect(calls.find((args) => args[0] === "commit")).toBeUndefined();
    });

    test("a missing container without a snapshot is left alone", async () => {
      const { exec, calls } = routerMock({ status: "missing", names: ["mikan-sandbox-c123-k"] });
      const manager = new DockerContainerManager("base", { execFileImpl: exec });
      manager.armContainerLayoutMigration(translator);

      await manager.sweepContainerLayoutMigration(0);

      expect(dockerWrites(calls)).toEqual([]);
    });

    test("unarmed manager performs no layout work", async () => {
      const { exec, calls } = routerMock({ status: "missing" });
      const manager = new DockerContainerManager("base", { execFileImpl: exec });

      await manager.provision("c123-k");

      expect(calls.some((args) => args.some((arg) => arg.includes("mikan.migrate-binds")))).toBe(
        false,
      );
      expect(calls.some((args) => args[0] === "commit" || args[0] === "create")).toBe(false);
      expect(calls.some((args) => args[0] === "run")).toBe(true);
    });

    test("sweep resumes a crash-orphaned snapshot instead of reclaiming it", async () => {
      const { exec, calls } = routerMock({
        status: "missing",
        names: [],
        images: ["mikan-migrate:mikan-sandbox-c123-k"],
        imageBinds: LEGACY_BINDS,
      });
      const manager = new DockerContainerManager("base", { execFileImpl: exec });
      manager.armContainerLayoutMigration(translator);

      await manager.sweepContainerLayoutMigration(0);

      const create = calls.find((args) => args[0] === "create");
      expect(create).toBeDefined();
      for (const bind of NEW_BINDS) expect(create).toContain(bind);
      expect(calls).toContainEqual(["rmi", "mikan-migrate:mikan-sandbox-c123-k"]);
    });

    test("sweep walks managed containers and reclaims orphaned snapshots", async () => {
      const { exec, calls } = routerMock({
        status: "stopped",
        binds: NEW_BINDS,
        names: ["mikan-sandbox-c123-k"],
        images: ["mikan-migrate:mikan-sandbox-gone"],
        imageBinds: [],
      });
      const manager = new DockerContainerManager("base", { execFileImpl: exec });
      manager.armContainerLayoutMigration(translator);

      await manager.sweepContainerLayoutMigration(0);

      expect(calls).toContainEqual(["rmi", "mikan-migrate:mikan-sandbox-gone"]);
    });

    test("sweep keeps a snapshot its container still runs from instead of warning on every restart", async () => {
      const { exec, calls } = routerMock({
        status: "stopped",
        binds: NEW_BINDS,
        names: ["mikan-sandbox-c123-k"],
        images: ["mikan-migrate:mikan-sandbox-c123-k"],
        imageBinds: LEGACY_BINDS,
        imageRef: "mikan-migrate:mikan-sandbox-c123-k",
      });
      const manager = new DockerContainerManager("base", { execFileImpl: exec });
      manager.armContainerLayoutMigration(translator);

      await manager.sweepContainerLayoutMigration(0);

      expect(calls).not.toContainEqual(["rmi", "mikan-migrate:mikan-sandbox-c123-k"]);
      expect(dockerWrites(calls)).toEqual([]);
    });
  });

  test("removeContainersForConversations removes only labeled matches", async () => {
    const execMock = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === "ps") {
        return { stdout: "mikan-sandbox-a\nmikan-sandbox-b\n" };
      }
      if (args[0] === "inspect") {
        const name = args[args.length - 1];
        return {
          stdout:
            name === "mikan-sandbox-a"
              ? "true\t2026-01-01T00:00:00Z\tvault-a\tC123\n"
              : "true\t2026-01-01T00:00:00Z\tvault-b\tD999\n",
        };
      }
      return { stdout: "" };
    });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

    await manager.removeContainersForConversations(new Set(["C123"]));

    const rmCalls = execMock.mock.calls.filter(([, args]) => args[0] === "rm");
    expect(rmCalls).toEqual([["docker", ["rm", "-f", "mikan-sandbox-a"]]]);
  });

  test("re-checks a cached container and starts it when it was stopped", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValueOnce({ stdout: "false\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValueOnce({ stdout: "started\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

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
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "volume\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

    await manager.provision("slack-u123");
    await manager.provision("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(7, "docker", [
      "run",
      "-d",
      "--name",
      "mikan-sandbox-slack-u123",
      "--network",
      "mikan-sandbox-net-slack-u123",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "1024",
      "--label",
      "mikan.managed=true",
      "--label",
      "mikan.sandbox=image",
      "--label",
      "mikan.vault-id=slack-u123",
      "-v",
      "mikan-home-slack-u123:/root",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
  });

  test("provisions custom container names with extra vault mounts", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockRejectedValueOnce(new Error("No such network"))
      .mockResolvedValueOnce({ stdout: "network-id\n" })
      .mockResolvedValueOnce({ stdout: "volume\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" })
      .mockResolvedValueOnce({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

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
    expect(execMock).toHaveBeenNthCalledWith(5, "docker", [
      "run",
      "-d",
      "--name",
      "alice-box",
      "--network",
      "mikan-sandbox-net-alice",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "1024",
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
      "mikan-home-alice:/root",
      "-v",
      "/tmp/vaults/alice/.ssh:/root/.ssh",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(6, "docker", ["stop", "alice-box"]);
  });

  test("a read-only mount gets the :ro bind suffix", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockRejectedValueOnce(new Error("No such network"))
      .mockResolvedValueOnce({ stdout: "network-id\n" })
      .mockResolvedValueOnce({ stdout: "volume\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

    await manager.provision("alice", {
      mounts: [
        {
          source: "/state/shared/data",
          target: "/opt/shared/data",
          readOnly: true,
        },
        { source: "/work/C1", target: "/workspace/C1" },
      ],
      conversationId: "C1",
    });

    const runArgs = execMock.mock.calls[4]?.[1];
    expect(runArgs).toContain("/state/shared/data:/opt/shared/data:ro");
    expect(runArgs).toContain("/work/C1:/workspace/C1");
  });

  test("flipping an existing mount to read-only is drift, so the container is recreated preserving contents", async () => {
    const mounts = [{ source: "/state/shared/data", target: "/opt/shared/data", readOnly: true }];
    const { exec, calls } = routerMock({
      status: "running",
      binds: ["/state/shared/data:/opt/shared/data"],
    });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: exec });
    const logInfo = vi.spyOn(log, "logInfo").mockImplementation(() => {});

    await manager.provision("alice", { mounts, conversationId: "C1" });

    expect(logInfo).toHaveBeenCalledWith(
      "Container mikan-sandbox-alice configuration changed (binds); recreating container",
    );
    logInfo.mockRestore();
    const commit = calls.find((args) => args[0] === "commit");
    expect(commit).toContain(
      `LABEL mikan.migrate-binds=${JSON.stringify(JSON.stringify(["/state/shared/data:/opt/shared/data:ro"]))}`,
    );
    expect(calls.some((args) => args[0] === "rm" && args[1] === "-f")).toBe(true);
    const createArgs = calls.find((args) => args[0] === "create");
    expect(createArgs).toContain("/state/shared/data:/opt/shared/data:ro");
    expect(createArgs).toContain("mikan-migrate:mikan-sandbox-alice");
    expect(calls.some((args) => args[0] === "start")).toBe(true);
    expect(calls.some((args) => args[0] === "run")).toBe(false);
    expect(calls).toContainEqual(["rmi", "mikan-migrate:mikan-sandbox-alice"]);
  });

  test("recreation removes stale /workspace/public mountpoints left in the snapshot", async () => {
    const mounts = [
      { source: "/ws/a", target: "/workspace/a" },
      { source: "/ws/b", target: "/workspace/public/b", readOnly: true },
    ];
    const { exec, calls } = routerMock({
      status: "running",
      binds: ["/ws/a:/workspace/a", "/ws/b:/workspace/public/b:ro", "/ws/c:/workspace/public/c:ro"],
    });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: exec });

    await manager.provision("alice", { mounts, conversationId: "C1" });

    const startIndex = calls.findIndex((args) => args[0] === "start");
    const cleanup = calls.slice(startIndex).find((args) => args[0] === "exec");
    expect(cleanup).toBeDefined();
    expect(cleanup).toContain("KEEP=b");
    expect(cleanup?.at(-1)).toContain("rmdir");
  });

  test("creates the network when docker reports '<name> not found'", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockRejectedValueOnce(
        new Error(
          "Error response from daemon: network mikan-sandbox-net-slack-u123-d123 not found",
        ),
      )
      .mockResolvedValueOnce({ stdout: "network-id\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

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

  test("recreates existing containers preserving contents when vault mounts change", async () => {
    const { exec, calls } = routerMock({
      status: "running",
      binds: ["/tmp/vaults/alice/.ssh:/root/.ssh"],
    });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: exec });

    await manager.provision("alice", {
      containerName: "alice-box",
      mounts: [{ source: "/tmp/vaults/alice/.kube", target: "/root/.kube" }],
      conversationId: "D123",
    });

    const commit = calls.find((args) => args[0] === "commit");
    expect(commit).toContain("alice-box");
    expect(commit).toContain("mikan-migrate:alice-box");
    expect(commit).toContain(
      `LABEL mikan.migrate-binds=${JSON.stringify(JSON.stringify(["/tmp/vaults/alice/.kube:/root/.kube"]))}`,
    );
    expect(calls.some((args) => args[0] === "rm" && args[2] === "alice-box")).toBe(true);
    const createArgs = calls.find((args) => args[0] === "create");
    expect(createArgs).toEqual([
      "create",
      "--name",
      "alice-box",
      "--network",
      "mikan-sandbox-net-alice",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "1024",
      "--label",
      "mikan.managed=true",
      "--label",
      "mikan.sandbox=image",
      "--label",
      "mikan.vault-id=alice",
      "--label",
      "mikan.conversation-id=ok",
      "--label",
      expect.stringMatching(/^mikan\.mount-signature=[a-f0-9]{64}$/),
      "-v",
      "/tmp/vaults/alice/.kube:/root/.kube",
      "mikan-migrate:alice-box",
      "sleep",
      "infinity",
    ]);
    expect(calls.some((args) => args[0] === "start" && args[1] === "alice-box")).toBe(true);
    expect(calls.some((args) => args[0] === "run")).toBe(false);
  });

  test("recreates existing containers preserving contents when network isolation is missing", async () => {
    const { exec, calls } = routerMock({ status: "running", binds: [], networkMode: "bridge" });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: exec });
    const logInfo = vi.spyOn(log, "logInfo").mockImplementation(() => {});

    await manager.provision("slack-u123");

    expect(logInfo).toHaveBeenCalledWith(
      "Container mikan-sandbox-slack-u123 configuration changed (network); recreating container",
    );
    logInfo.mockRestore();

    expect(calls.some((args) => args[0] === "commit")).toBe(true);
    expect(calls.some((args) => args[0] === "rm" && args[2] === "mikan-sandbox-slack-u123")).toBe(
      true,
    );
    const createArgs = calls.find((args) => args[0] === "create");
    expect(createArgs).toContain("--network");
    expect(createArgs).toContain("mikan-sandbox-net-slack-u123");
    expect(createArgs).toContain("mikan-migrate:mikan-sandbox-slack-u123");
    expect(calls.some((args) => args[0] === "start")).toBe(true);
  });

  test("directory activity is not drift, but a replaced directory is", async () => {
    const source = mkdtempSync(join(tmpdir(), "mikan-fingerprint-"));
    try {
      const mounts = [{ source, target: "/workspace/office" }];
      const bind = `${source}:/workspace/office`;

      const fresh = routerMock({ status: "missing" });
      const freshManager = new DockerContainerManager("ubuntu:24.04", {
        execFileImpl: fresh.exec,
      });
      await freshManager.provision("alice", { mounts });
      const runArgs = fresh.calls.find((args) => args[0] === "run");
      const signature = runArgs
        ?.find((arg: string) => arg.startsWith("mikan.mount-signature="))
        ?.slice("mikan.mount-signature=".length);
      expect(signature).toMatch(/^[a-f0-9]{64}$/);

      writeFileSync(join(source, "log.jsonl"), "line\n");
      const withLabel = (sig: string) => {
        const { exec, calls } = routerMock({
          status: "running",
          binds: [bind],
          networkMode: "mikan-sandbox-net-alice",
        });
        const inner = exec.getMockImplementation()!;
        exec.mockImplementation(async (file: string, args: string[]) => {
          if (args[0] === "inspect" && args[2]?.includes("mount-signature")) {
            return { stdout: `${sig}\n` };
          }
          return inner(file, args);
        });
        return { exec, calls };
      };
      const stable = withLabel(signature!);
      const stableManager = new DockerContainerManager("ubuntu:24.04", {
        execFileImpl: stable.exec,
      });
      const logInfo = vi.spyOn(log, "logInfo").mockImplementation(() => {});
      await stableManager.provision("alice", { mounts });
      expect(stable.calls.some((args) => args[0] === "commit" || args[0] === "rm")).toBe(false);
      expect(logInfo).not.toHaveBeenCalledWith("Container mikan-sandbox-alice already running");
      logInfo.mockRestore();

      rmSync(source, { recursive: true, force: true });
      mkdirSync(source);
      const replaced = withLabel(signature!);
      const replacedManager = new DockerContainerManager("ubuntu:24.04", {
        execFileImpl: replaced.exec,
      });
      const replacedLog = vi.spyOn(log, "logInfo").mockImplementation(() => {});
      await replacedManager.provision("alice", { mounts });
      expect(replacedLog).toHaveBeenCalledWith(
        "Container mikan-sandbox-alice configuration changed (mount-content); recreating container",
      );
      replacedLog.mockRestore();
      expect(replaced.calls.some((args) => args[0] === "commit")).toBe(true);
      expect(replaced.calls.some((args) => args[0] === "start")).toBe(true);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("stopIdle stops only containers idle longer than threshold", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u111\n" })
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u222\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });
    const provisionedAt = Date.parse("2026-04-22T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: provisionedAt });

    try {
      await manager.provision("slack-u111");
      vi.setSystemTime(provisionedAt + 7200000);
      await manager.provision("slack-u222");

      execMock.mockResolvedValue({ stdout: "" });
      await manager.stopIdle(3600000);
    } finally {
      vi.useRealTimers();
    }

    const stopCalls = execMock.mock.calls.filter((c) => c[0] === "docker" && c[1][0] === "stop");
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]?.[1]).toEqual(["stop", "mikan-sandbox-slack-u111"]);
  });

  test("reconcile discovers labeled containers and restores state", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-slack-u123-d123\n" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({
        stdout: "true\t2026-04-22T00:00:00.000000000Z\tslack-u123\tD123\n",
      });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

    const startedAt = Date.parse("2026-04-22T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: startedAt + 1000 });

    try {
      await manager.reconcile();
      execMock.mockResolvedValue({ stdout: "" });

      await manager.stopIdle(1000);
      expect(stopCallsOf(execMock)).toEqual([]);

      await manager.stopIdle(999);
      expect(stopCallsOf(execMock)).toEqual([["stop", "mikan-sandbox-slack-u123-d123"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("reconcile removes legacy containers without conversation labels", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-slack-u123\n" })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "true\t2026-04-22T00:00:00.000000000Z\tslack-u123\t\n" })
      .mockResolvedValueOnce({ stdout: "removed\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

    await manager.reconcile();

    expect(execMock).toHaveBeenNthCalledWith(4, "docker", ["rm", "-f", "mikan-sandbox-slack-u123"]);
    await manager.stopIdle(-1);
    expect(stopCallsOf(execMock)).toEqual([]);
  });

  test("reconcile reaps containers keyed by the pre-office raw-conversation identity", async () => {
    const legacyKey = legacyConversationResourceKey("D123");
    const execMock = vi
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: `mikan-sandbox-${legacyKey}\n` })
      .mockResolvedValueOnce({ stdout: "" })
      .mockResolvedValueOnce({ stdout: "true\t2026-04-22T00:00:00.000000000Z\tslack-u123\tD123\n" })
      .mockResolvedValueOnce({ stdout: "removed\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

    await manager.reconcile();

    expect(execMock).toHaveBeenNthCalledWith(4, "docker", [
      "rm",
      "-f",
      `mikan-sandbox-${legacyKey}`,
    ]);
    await manager.stopIdle(-1);
    expect(stopCallsOf(execMock)).toEqual([]);
  });

  test("concurrent provision calls for the same vaultId share one docker run", async () => {
    const startDeferred = createDeferred<{ stdout: string }>();
    const execMock = vi
      .fn<DockerExecFile>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "volume\n" })
      .mockReturnValueOnce(startDeferred.promise);

    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

    const first = manager.provision("slack-u123");
    const second = manager.provision("slack-u123");

    startDeferred.resolve({ stdout: "new-container-id\n" });
    await Promise.all([first, second]);

    expect(execMock).toHaveBeenCalledTimes(4);
    expect(execMock.mock.calls[0]?.[1][0]).toBe("inspect");
    expect(execMock.mock.calls[3]?.[1][0]).toBe("run");
  });

  test("failed docker start clears cached state and allows re-inspection", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: "false\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockRejectedValueOnce(new Error("docker start failed"))
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "new-id\n" });

    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

    await expect(manager.provision("slack-u123")).rejects.toThrow(/start failed/);

    await manager.stopIdle(-1);
    expect(stopCallsOf(execMock)).toEqual([]);

    await expect(manager.provision("slack-u123")).resolves.toBe("mikan-sandbox-slack-u123");
    expect(execMock.mock.calls[4]?.[1][0]).toBe("inspect");
  });

  test("passes --cpus, --memory, and --memory-swap to docker run when limits are configured", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "volume\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" })
      .mockResolvedValueOnce({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { cpus: "0.5", memory: "512m" },
      execFileImpl: execMock,
    });

    await manager.provision("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(4, "docker", [
      "run",
      "-d",
      "--name",
      "mikan-sandbox-slack-u123",
      "--network",
      "mikan-sandbox-net-slack-u123",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "1024",
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
      "-v",
      "mikan-home-slack-u123:/root",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
    expect(execMock).toHaveBeenNthCalledWith(5, "docker", [
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
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValueOnce({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { cpus: "1", memory: "1g" },
      execFileImpl: execMock,
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
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

    await manager.provision("slack-u123");

    const updateCalls = execMock.mock.calls.filter((c) => c[1][0] === "update");
    expect(updateCalls).toHaveLength(0);
  });

  test("setLimits applies temporary limits to a running container", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValue({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { cpus: "0.5", memory: "1g" },
      execFileImpl: execMock,
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
      .fn<DockerExecFile>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "volume\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" })
      .mockResolvedValueOnce({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { memory: "1g" },
      execFileImpl: execMock,
    });

    await manager.setLimits("slack-u123", { cpus: "2" });
    await manager.provision("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(4, "docker", [
      "run",
      "-d",
      "--name",
      "mikan-sandbox-slack-u123",
      "--network",
      "mikan-sandbox-net-slack-u123",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "1024",
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
      "-v",
      "mikan-home-slack-u123:/root",
      "ubuntu:24.04",
      "sleep",
      "infinity",
    ]);
  });

  test("boost applies boost limits to a running container", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValue({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { cpus: "0.5", memory: "1g" },
      boostLimits: { cpus: "2", memory: "4g" },
      execFileImpl: execMock,
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
      .fn<DockerExecFile>()
      .mockResolvedValueOnce({ stdout: "true\n" })
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "mikan-sandbox-net-slack-u123\n" })
      .mockResolvedValue({ stdout: "" });
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { cpus: "0.5", memory: "1g" },
      boostLimits: { cpus: "2", memory: "4g" },
      execFileImpl: execMock,
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
      .fn<DockerExecFile>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "volume\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" })
      .mockRejectedValueOnce(new Error("docker update unsupported"));
    const manager = new DockerContainerManager("ubuntu:24.04", {
      limits: { memory: "256m" },
      execFileImpl: execMock,
    });

    await expect(manager.provision("slack-u123")).resolves.toBe("mikan-sandbox-slack-u123");
  });

  test("remove also deletes the per-vault network", async () => {
    const execMock = vi
      .fn<DockerExecFile>()
      .mockRejectedValueOnce(new Error("No such object"))
      .mockResolvedValueOnce({ stdout: "[]\n" })
      .mockResolvedValueOnce({ stdout: "volume\n" })
      .mockResolvedValueOnce({ stdout: "new-container-id\n" })
      .mockResolvedValueOnce({ stdout: "removed\n" })
      .mockResolvedValueOnce({ stdout: "network removed\n" });
    const manager = new DockerContainerManager("ubuntu:24.04", { execFileImpl: execMock });

    await manager.provision("slack-u123");
    await manager.remove("slack-u123");

    expect(execMock).toHaveBeenNthCalledWith(5, "docker", ["rm", "-f", "mikan-sandbox-slack-u123"]);
    expect(execMock).toHaveBeenNthCalledWith(6, "docker", [
      "network",
      "rm",
      "mikan-sandbox-net-slack-u123",
    ]);
  });
});
