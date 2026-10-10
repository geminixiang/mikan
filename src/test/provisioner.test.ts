import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as log from "../log.js";
import { DockerContainerManager } from "../sandbox/provisioner.js";
import type { DockerExecFile } from "../sandbox/types.js";

const IMAGE = "ubuntu:24.04";

interface FakeMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

interface FakeContainer {
  running: boolean;
  mounts: FakeMount[];
  labels: Record<string, string>;
  startedAt: string;
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function parseRun(args: string[]): { name: string; container: FakeContainer } {
  const container: FakeContainer = {
    running: true,
    mounts: [],
    labels: {},
    startedAt: "2026-04-22T00:00:00Z",
  };
  let name = "";
  for (let index = 1; index < args.length; index++) {
    const value = args[index + 1] ?? "";
    if (args[index] === "--name") name = value;
    if (args[index] === "--label") {
      const at = value.indexOf("=");
      container.labels[value.slice(0, at)] = value.slice(at + 1);
    }
    if (args[index] === "-v") {
      const [source = "", target = "", mode] = value.split(":");
      container.mounts.push({ source, target, readOnly: mode === "ro" });
    }
  }
  return { name, container };
}

class FakeEngine {
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Set<string>();
  readonly images = new Map<string, string>([[IMAGE, "sha256:current"]]);
  readonly calls: string[][] = [];
  readonly failures = new Map<string, Error>();
  readonly holds = new Map<string, Promise<unknown>>();
  readonly exec = vi.fn<DockerExecFile>(async (_file, args) => this.handle(args));

  seed(name: string, key: string, overrides: Partial<FakeContainer> = {}): FakeContainer {
    const container: FakeContainer = {
      running: true,
      mounts: [],
      startedAt: "2026-04-22T00:00:00Z",
      ...overrides,
      labels: {
        "mikan.managed": "true",
        "mikan.sandbox": "image",
        "mikan.network": DockerContainerManager.networkName(key),
        "mikan.image-id": "sha256:current",
        ...overrides.labels,
      },
    };
    this.containers.set(name, container);
    this.networks.add(DockerContainerManager.networkName(key));
    return container;
  }

  callsOf(command: string): string[][] {
    return this.calls.filter((args) => args[0] === command);
  }

  private async handle(args: string[]): Promise<{ stdout: string }> {
    this.calls.push(args);
    const failure = this.failures.get(args[0] ?? "");
    if (failure) {
      this.failures.delete(args[0] ?? "");
      throw failure;
    }
    await this.holds.get(args[0] ?? "");
    const name = args.at(-1) ?? "";
    switch (args[0]) {
      case "ps":
        return { stdout: lines(this.listContainers(args)) };
      case "inspect":
        return { stdout: `${this.inspect(args[2] ?? "", name)}\n` };
      case "image": {
        const id = this.images.get(name);
        if (!id) throw new Error(`Error: no such image: ${name}`);
        return { stdout: `${id}\n` };
      }
      case "pull":
        this.images.set(name, "sha256:pulled");
        return { stdout: "" };
      case "network":
        return { stdout: this.network(args) };
      case "run": {
        const run = parseRun(args);
        this.containers.set(run.name, run.container);
        return { stdout: "new-container-id\n" };
      }
      case "start":
        this.mustGet(name).running = true;
        return { stdout: `${name}\n` };
      case "stop":
        this.mustGet(name).running = false;
        return { stdout: `${name}\n` };
      case "rm":
        this.containers.delete(name);
        return { stdout: `${name}\n` };
      default:
        return { stdout: "" };
    }
  }

  private listContainers(args: string[]): string[] {
    const nameFilter = args.find((arg) => arg.startsWith("name=^"));
    if (nameFilter) {
      const wanted = nameFilter.slice("name=^".length, -1);
      return this.containers.has(wanted) ? [wanted] : [];
    }
    return [...this.containers.keys()];
  }

  private inspect(template: string, name: string): string {
    const container = this.mustGet(name);
    const mounts = JSON.stringify(
      container.mounts.map((mount) => ({
        Type: "bind",
        Source: mount.source,
        Destination: mount.target,
        Mode: "",
        RW: !mount.readOnly,
        Propagation: "rprivate",
      })),
    );
    if (template === "{{.State.Running}}") return String(container.running);
    if (template === "{{json .Mounts}}") return mounts;
    if (template.startsWith("{{.State.Running}}\t")) {
      return `${container.running}\t${container.startedAt}\t${mounts}`;
    }
    const label = /index \.Config\.Labels "([^"]+)"/.exec(template)?.[1];
    if (label) return container.labels[label] ?? "<no value>";
    throw new Error(`unexpected inspect template ${template}`);
  }

  private network(args: string[]): string {
    const name = args.at(-1) ?? "";
    if (args[1] === "ls") {
      const wanted = (args.find((arg) => arg.startsWith("name=^")) ?? "").slice(6, -1);
      return lines(this.networks.has(wanted) ? [wanted] : []);
    }
    if (args[1] === "create") this.networks.add(name);
    if (args[1] === "rm") this.networks.delete(name);
    return `${name}\n`;
  }

  private mustGet(name: string): FakeContainer {
    const container = this.containers.get(name);
    if (!container) throw new Error(`Error: no such object: ${name}`);
    return container;
  }
}

function mountedAt(root: string): FakeMount[] {
  return [{ source: `${root}/x`, target: "/workspace" }];
}

function lines(values: string[]): string {
  return values.map((value) => `${value}\n`).join("");
}

function manager(engine: FakeEngine, options: { limits?: object; boostLimits?: object } = {}) {
  return new DockerContainerManager(IMAGE, { ...options, execFileImpl: engine.exec });
}

function infoLogs() {
  return vi.spyOn(log, "logInfo").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("DockerContainerManager", () => {
  test("runs every command through the configured engine", async () => {
    const engine = new FakeEngine();
    const podman = new DockerContainerManager(IMAGE, {
      engine: "podman",
      execFileImpl: engine.exec,
    });

    await podman.provision("slack-u123");

    expect(new Set(engine.exec.mock.calls.map(([file]) => file))).toEqual(new Set(["podman"]));
  });

  test("re-checks a cached container and starts it when it was stopped", async () => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-slack-u123", "slack-u123");
    const sandbox = manager(engine);

    await sandbox.provision("slack-u123");
    engine.containers.get("mikan-sandbox-slack-u123")!.running = false;
    await sandbox.provision("slack-u123");

    expect(engine.callsOf("start")).toEqual([["start", "mikan-sandbox-slack-u123"]]);
    expect(engine.callsOf("run")).toEqual([]);
    expect(engine.callsOf("rm")).toEqual([]);
  });

  test("re-checks a cached container and recreates it when it was deleted", async () => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-slack-u123", "slack-u123");
    const sandbox = manager(engine);

    await sandbox.provision("slack-u123");
    engine.containers.delete("mikan-sandbox-slack-u123");
    await sandbox.provision("slack-u123");

    expect(engine.callsOf("run")).toEqual([
      [
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
        "--label",
        "mikan.network=mikan-sandbox-net-slack-u123",
        "--label",
        "mikan.image-id=sha256:current",
        IMAGE,
        "sleep",
        "infinity",
      ],
    ]);
  });

  test("provisions custom container names with extra vault mounts", async () => {
    const engine = new FakeEngine();
    const sandbox = manager(engine);

    await sandbox.provision("alice", {
      containerName: "alice-box",
      mounts: [{ source: "/tmp/vaults/alice/.ssh", target: "/root/.ssh" }],
      conversationId: "D123",
    });
    await sandbox.stop("alice");

    expect(engine.callsOf("network").at(-1)).toEqual([
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
    expect(engine.callsOf("run")[0]).toEqual([
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
      "--label",
      "mikan.network=mikan-sandbox-net-alice",
      "--label",
      "mikan.image-id=sha256:current",
      "-v",
      "/tmp/vaults/alice/.ssh:/root/.ssh",
      IMAGE,
      "sleep",
      "infinity",
    ]);
    expect(engine.callsOf("stop")).toEqual([["stop", "alice-box"]]);
  });

  test("checks for the per-office network by name and creates it only when absent", async () => {
    const engine = new FakeEngine();
    const sandbox = manager(engine);

    await sandbox.provision("slack-u123-d123");
    await sandbox.remove("slack-u123-d123");
    engine.networks.add("mikan-sandbox-net-slack-u123-d123");
    await sandbox.provision("slack-u123-d123");

    expect(engine.callsOf("network")).toEqual([
      [
        "network",
        "ls",
        "--filter",
        "name=^mikan-sandbox-net-slack-u123-d123$",
        "--format",
        "{{.Name}}",
      ],
      [
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
      ],
      ["network", "rm", "mikan-sandbox-net-slack-u123-d123"],
      [
        "network",
        "ls",
        "--filter",
        "name=^mikan-sandbox-net-slack-u123-d123$",
        "--format",
        "{{.Name}}",
      ],
    ]);
  });

  test("pulls the image before the first run, so the container records its image ID", async () => {
    const engine = new FakeEngine();
    engine.images.clear();

    await manager(engine).provision("alice");

    expect(engine.callsOf("pull")).toEqual([["pull", IMAGE]]);
    expect(engine.callsOf("run")[0]).toContain("mikan.image-id=sha256:pulled");
  });

  test("a read-only mount gets the :ro bind suffix", async () => {
    const engine = new FakeEngine();

    await manager(engine).provision("alice", {
      mounts: [
        { source: "/state/shared/data", target: "/opt/shared/data", readOnly: true },
        { source: "/work/C1", target: "/workspace/C1" },
      ],
      conversationId: "C1",
    });

    const runArgs = engine.callsOf("run")[0];
    expect(runArgs).toContain("/state/shared/data:/opt/shared/data:ro");
    expect(runArgs).toContain("/work/C1:/workspace/C1");
  });

  test("bind mounts are compared by source, target, and access, ignoring engine options", async () => {
    const source = mkdtempSync(join(tmpdir(), "mikan-binds-"));
    try {
      const engine = new FakeEngine();
      const mounts = [{ source, target: "/workspace/office" }];
      const sandbox = manager(engine);
      await sandbox.provision("alice", { mounts });
      const logs = infoLogs();

      await sandbox.provision("alice", { mounts });

      expect(logs).not.toHaveBeenCalledWith(expect.stringContaining("out of date"));
      expect(engine.callsOf("run")).toHaveLength(1);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("flipping an existing mount to read-only is drift, so the container is replaced", async () => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-alice", "alice", {
      mounts: [{ source: "/state/shared/data", target: "/opt/shared/data" }],
    });
    const logs = infoLogs();

    await manager(engine).provision("alice", {
      mounts: [{ source: "/state/shared/data", target: "/opt/shared/data", readOnly: true }],
      conversationId: "C1",
    });

    expect(logs).toHaveBeenCalledWith(
      "Container mikan-sandbox-alice is out of date (binds); replacing container",
    );
    expect(engine.callsOf("rm")).toEqual([["rm", "-f", "mikan-sandbox-alice"]]);
    expect(engine.callsOf("run")[0]).toContain("/state/shared/data:/opt/shared/data:ro");
  });

  test("replaces an existing container from the image when vault mounts change", async () => {
    const engine = new FakeEngine();
    engine.seed("alice-box", "alice", {
      mounts: [{ source: "/tmp/vaults/alice/.ssh", target: "/root/.ssh" }],
    });

    await manager(engine).provision("alice", {
      containerName: "alice-box",
      mounts: [{ source: "/tmp/vaults/alice/.kube", target: "/root/.kube" }],
      conversationId: "D123",
    });

    expect(engine.callsOf("rm")).toEqual([["rm", "-f", "alice-box"]]);
    const runArgs = engine.callsOf("run")[0];
    expect(runArgs).toContain("/tmp/vaults/alice/.kube:/root/.kube");
    expect(runArgs).not.toContain("/tmp/vaults/alice/.ssh:/root/.ssh");
    expect(runArgs?.slice(-3)).toEqual([IMAGE, "sleep", "infinity"]);
  });

  test.each([
    ["is missing", undefined],
    ["names another network", "bridge"],
  ])("replaces an existing container whose network label %s", async (_case, network) => {
    const engine = new FakeEngine();
    const seeded = engine.seed("mikan-sandbox-slack-u123", "slack-u123");
    if (network) seeded.labels["mikan.network"] = network;
    else delete seeded.labels["mikan.network"];
    const logs = infoLogs();

    await manager(engine).provision("slack-u123");

    expect(logs).toHaveBeenCalledWith(
      "Container mikan-sandbox-slack-u123 is out of date (network); replacing container",
    );
    expect(engine.callsOf("rm")).toEqual([["rm", "-f", "mikan-sandbox-slack-u123"]]);
    expect(engine.callsOf("run")[0]).toContain("mikan-sandbox-net-slack-u123");
  });

  test.each([
    [false, true],
    [true, false],
  ])(
    "a container on an older image (running: %s) is replaced only while stopped",
    async (running, replaced) => {
      const engine = new FakeEngine();
      engine.seed("mikan-sandbox-alice", "alice", {
        running,
        labels: { "mikan.image-id": "sha256:old" },
      });

      await manager(engine).provision("alice");

      expect(engine.callsOf("run").length > 0).toBe(replaced);
      expect(engine.callsOf("start")).toEqual([]);
    },
  );

  test("a new container mounts only the office projection, with no home volume", async () => {
    const engine = new FakeEngine();

    await manager(engine).provision("alice", {
      mounts: [{ source: "/w/a", target: "/workspace/a" }],
    });

    const runArgs = engine.callsOf("run")[0] ?? [];
    const volumes = runArgs.flatMap((arg, index) => (runArgs[index - 1] === "-v" ? [arg] : []));
    expect(volumes).toEqual(["/w/a:/workspace/a"]);
    expect(engine.callsOf("volume")).toEqual([]);
  });

  test("directory activity is not drift, but a replaced directory is", async () => {
    const source = mkdtempSync(join(tmpdir(), "mikan-fingerprint-"));
    try {
      const mounts = [{ source, target: "/workspace/office" }];
      const engine = new FakeEngine();
      const sandbox = manager(engine);
      await sandbox.provision("alice", { mounts });

      writeFileSync(join(source, "log.jsonl"), "line\n");
      const stable = infoLogs();
      await sandbox.provision("alice", { mounts });
      expect(stable).not.toHaveBeenCalledWith(expect.stringContaining("out of date"));
      expect(engine.callsOf("rm")).toEqual([]);
      stable.mockRestore();

      rmSync(source, { recursive: true, force: true });
      mkdirSync(source);
      const replaced = infoLogs();
      await sandbox.provision("alice", { mounts });
      expect(replaced).toHaveBeenCalledWith(
        "Container mikan-sandbox-alice is out of date (mount-content); replacing container",
      );
      expect(engine.callsOf("rm")).toEqual([["rm", "-f", "mikan-sandbox-alice"]]);
      expect(engine.callsOf("run")).toHaveLength(2);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("stopIdle stops only containers idle longer than threshold", async () => {
    const engine = new FakeEngine();
    const sandbox = manager(engine);
    const provisionedAt = Date.parse("2026-04-22T00:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"], now: provisionedAt });

    await sandbox.provision("slack-u111");
    vi.setSystemTime(provisionedAt + 7200000);
    await sandbox.provision("slack-u222");
    await sandbox.stopIdle(3600000);

    expect(engine.callsOf("stop")).toEqual([["stop", "mikan-sandbox-slack-u111"]]);
  });

  test.each([
    ["Docker's RFC 3339", "2026-04-22T00:00:00.000000000Z"],
    ["Podman's local time", "2026-04-22 08:00:00.000000000 +0800 CST"],
  ])("reconcile restores idle time from %s start timestamps", async (_format, startedAt) => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-slack-u123-d123", "slack-u123-d123", {
      startedAt,
      mounts: [{ source: "/srv/mikan/workspace/slack-u123-d123", target: "/workspace" }],
    });
    const sandbox = manager(engine);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-04-22T00:00:01.000Z") });

    await sandbox.reconcile("/srv/mikan/workspace");
    await sandbox.stopIdle(1000);
    expect(engine.callsOf("stop")).toEqual([]);

    await sandbox.stopIdle(999);
    expect(engine.callsOf("stop")).toEqual([["stop", "mikan-sandbox-slack-u123-d123"]]);
  });

  test("reconcile leaves containers of another workspace alone", async () => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-slack-u1", "slack-u1", { mounts: mountedAt("/srv/a/workspace") });
    engine.seed("mikan-sandbox-slack-u2", "slack-u2", { mounts: mountedAt("/srv/b/workspace") });
    engine.seed("mikan-sandbox-slack-u3", "slack-u3", {
      mounts: mountedAt("/srv/a/workspace-old"),
    });
    const sandbox = manager(engine);

    await sandbox.reconcile("/srv/a/workspace");
    await sandbox.stopIdle(-1);

    expect(engine.callsOf("stop")).toEqual([["stop", "mikan-sandbox-slack-u1"]]);
  });

  test("reconcile ends commands a previous process left running in its containers", async () => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-slack-u1", "slack-u1", { mounts: mountedAt("/srv/a/workspace") });
    engine.seed("mikan-sandbox-slack-u2", "slack-u2", {
      running: false,
      mounts: mountedAt("/srv/a/workspace"),
    });
    engine.seed("mikan-sandbox-slack-u3", "slack-u3", { mounts: mountedAt("/srv/b/workspace") });

    await manager(engine).reconcile("/srv/a/workspace");

    const sweeps = engine.callsOf("exec");
    expect(sweeps.map((args) => args[1])).toEqual(["mikan-sandbox-slack-u1"]);
    expect(sweeps[0]?.join(" ")).toContain("/tmp/mikan-exec-");
  });

  test("concurrent provision calls for the same vaultId share one run", async () => {
    const engine = new FakeEngine();
    const run = createDeferred<void>();
    engine.holds.set("run", run.promise);
    const sandbox = manager(engine);

    const first = sandbox.provision("slack-u123");
    const second = sandbox.provision("slack-u123");
    run.resolve();
    await Promise.all([first, second]);

    expect(engine.callsOf("run")).toHaveLength(1);
  });

  test("failed start clears cached state and allows re-inspection", async () => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-slack-u123", "slack-u123", { running: false });
    engine.failures.set("start", new Error("start failed"));
    const sandbox = manager(engine);

    await expect(sandbox.provision("slack-u123")).rejects.toThrow(/start failed/);
    await sandbox.stopIdle(-1);
    expect(engine.callsOf("stop")).toEqual([]);

    await expect(sandbox.provision("slack-u123")).resolves.toBe("mikan-sandbox-slack-u123");
    expect(engine.callsOf("start")).toHaveLength(2);
  });

  test("sets CPU limits as a quota per period, which every engine can update", async () => {
    const engine = new FakeEngine();

    await manager(engine, { limits: { cpus: "0.5", memory: "512m" } }).provision("slack-u123");

    const limitArgs = [
      "--cpu-period",
      "100000",
      "--cpu-quota",
      "50000",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
    ];
    expect(engine.callsOf("run")[0]?.join(" ")).toContain(limitArgs.join(" "));
    expect(engine.callsOf("update")).toEqual([
      ["update", ...limitArgs, "mikan-sandbox-slack-u123"],
    ]);
  });

  test("applies limits to already-running containers", async () => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-slack-u123", "slack-u123");

    await manager(engine, { limits: { cpus: "1", memory: "1g" } }).provision("slack-u123");

    expect(engine.callsOf("update")).toEqual([
      [
        "update",
        "--cpu-period",
        "100000",
        "--cpu-quota",
        "100000",
        "--memory",
        "1g",
        "--memory-swap",
        "1g",
        "mikan-sandbox-slack-u123",
      ],
    ]);
  });

  test("skips update when no limits are configured", async () => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-slack-u123", "slack-u123");

    await manager(engine).provision("slack-u123");

    expect(engine.callsOf("update")).toEqual([]);
  });

  test("setLimits applies temporary limits to a running container", async () => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-slack-u123", "slack-u123");
    const sandbox = manager(engine, { limits: { cpus: "0.5", memory: "1g" } });

    await sandbox.provision("slack-u123");
    const status = await sandbox.setLimits("slack-u123", { cpus: "2", memory: "4g" });

    expect(status).toEqual({ limits: { cpus: "2", memory: "4g" }, boosted: false });
    expect(engine.callsOf("update").at(-1)).toEqual([
      "update",
      "--cpu-period",
      "100000",
      "--cpu-quota",
      "200000",
      "--memory",
      "4g",
      "--memory-swap",
      "4g",
      "mikan-sandbox-slack-u123",
    ]);
  });

  test("setLimits affects the next run before a container exists", async () => {
    const engine = new FakeEngine();
    const sandbox = manager(engine, { limits: { memory: "1g" } });

    await sandbox.setLimits("slack-u123", { cpus: "2" });
    await sandbox.provision("slack-u123");

    expect(engine.callsOf("run")[0]?.join(" ")).toContain(
      "--cpu-period 100000 --cpu-quota 200000 --memory 1g --memory-swap 1g",
    );
  });

  test("boost applies boost limits to a running container", async () => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-slack-u123", "slack-u123");
    const sandbox = manager(engine, {
      limits: { cpus: "0.5", memory: "1g" },
      boostLimits: { cpus: "2", memory: "4g" },
    });

    await sandbox.provision("slack-u123");
    const status = await sandbox.boost("slack-u123");

    expect(status).toEqual({ limits: { cpus: "2", memory: "4g" }, boosted: true });
    expect(engine.callsOf("update").at(-1)?.join(" ")).toBe(
      "update --cpu-period 100000 --cpu-quota 200000 --memory 4g --memory-swap 4g mikan-sandbox-slack-u123",
    );
  });

  test("stopping a container clears boost state", async () => {
    const engine = new FakeEngine();
    engine.seed("mikan-sandbox-slack-u123", "slack-u123");
    const sandbox = manager(engine, {
      limits: { cpus: "0.5", memory: "1g" },
      boostLimits: { cpus: "2", memory: "4g" },
    });

    await sandbox.provision("slack-u123");
    await sandbox.boost("slack-u123");
    await sandbox.stop("slack-u123");

    expect(sandbox.getLimitStatus("slack-u123")).toEqual({
      limits: { cpus: "0.5", memory: "1g" },
      boosted: false,
    });
  });

  test("provision succeeds even when update fails", async () => {
    const engine = new FakeEngine();
    engine.failures.set("update", new Error("update unsupported"));

    await expect(
      manager(engine, { limits: { memory: "256m" } }).provision("slack-u123"),
    ).resolves.toBe("mikan-sandbox-slack-u123");
  });

  test("remove deletes the container and the per-office network", async () => {
    const engine = new FakeEngine();
    const sandbox = manager(engine);

    await sandbox.provision("slack-u123");
    await sandbox.remove("slack-u123");
    await sandbox.remove("slack-u123");

    expect(engine.callsOf("rm")).toEqual([["rm", "-f", "mikan-sandbox-slack-u123"]]);
    expect(engine.callsOf("network").slice(-2)).toEqual([
      ["network", "rm", "mikan-sandbox-net-slack-u123"],
      ["network", "rm", "mikan-sandbox-net-slack-u123"],
    ]);
  });
});
