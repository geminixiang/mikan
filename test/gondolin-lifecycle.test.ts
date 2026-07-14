import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const gondolin = vi.hoisted(() => ({
  ensureImageSelector: vi.fn(async (selector: string) => ({
    assetDir: `/images/${selector}`,
    buildId: selector,
  })),
}));

vi.mock("@earendil-works/gondolin", () => ({
  ensureImageSelector: gondolin.ensureImageSelector,
  connectToSession: vi.fn(),
  gcSessions: vi.fn(async () => 0),
  VM: { create: vi.fn() },
  RealFSProvider: vi.fn(),
}));

import {
  GondolinExecutor,
  disconnectAllGondolinRuntimes,
  gondolinResources,
  stopIdleGondolinVms,
  sweepUnadoptedGondolinWorkers,
} from "../src/sandbox/gondolin.js";
import { gondolinInventory } from "../src/sandbox/gondolin-inventory.js";
import { gondolinWorkers } from "../src/sandbox/gondolin-worker-client.js";
import type { GondolinWorkerConfig } from "../src/sandbox/gondolin-worker.js";

interface FakeExec {
  command: string;
  env: string[];
  cwd?: string;
  respond: (code: number) => void;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  drop: () => void;
}

interface FakeWorker {
  pid: number;
  sessionId: string;
  socketPath: string;
  config: GondolinWorkerConfig;
  execs: FakeExec[];
  autoRespond: boolean;
}

function createExecutor(instanceId: string, env?: Record<string, string>): GondolinExecutor {
  return new GondolinExecutor(
    { type: "gondolin", profile: "default", instanceId, workspacePath: "/workspace-host" },
    env,
  );
}

function frame(tag: number, id: number, data: string): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(tag, 0);
  header.writeUInt32BE(id, 1);
  return Buffer.concat([header, Buffer.from(data)]);
}

describe("Gondolin lifecycle", () => {
  const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
  let dir: string;
  let nextPid: number;
  let spawns: GondolinWorkerConfig[];
  let workers: Map<string, FakeWorker>;
  let alivePids: Set<number>;
  let signals: Array<{ pid: number; signal: NodeJS.Signals }>;
  let lingerOnSigterm: boolean;

  function recordPathFor(worker: FakeWorker): string {
    return join(dir, `${worker.sessionId}.json`);
  }

  function addWorker(config: GondolinWorkerConfig): FakeWorker {
    nextPid += 1;
    const worker: FakeWorker = {
      pid: nextPid,
      sessionId: `session-${nextPid}`,
      socketPath: `/sessions/session-${nextPid}.sock`,
      config,
      execs: [],
      autoRespond: true,
    };
    workers.set(worker.socketPath, worker);
    alivePids.add(worker.pid);
    writeFileSync(
      recordPathFor(worker),
      JSON.stringify({
        sessionId: worker.sessionId,
        instanceId: config.instanceId,
        ownerPid: worker.pid,
        runnerPid: worker.pid + 500,
        createdAt: new Date().toISOString(),
        socketPath: worker.socketPath,
        fingerprint: config.fingerprint,
      }),
    );
    return worker;
  }

  function crashWorker(worker: FakeWorker): void {
    // hard death: process gone, record left behind
    alivePids.delete(worker.pid);
  }

  const kill = (pid: number, signal: NodeJS.Signals | 0): void => {
    if (!alivePids.has(pid)) throw new Error("ESRCH");
    if (signal === 0) return;
    signals.push({ pid, signal });
    if (signal === "SIGTERM" && lingerOnSigterm) return;
    alivePids.delete(pid);
    if (signal === "SIGTERM") {
      // graceful worker shutdown releases its own record
      const worker = Array.from(workers.values()).find((entry) => entry.pid === pid);
      if (worker) rmSync(recordPathFor(worker), { force: true });
    }
  };

  const spawnProcess = (_command: string, args: string[]) => {
    const config = JSON.parse(args[1]) as GondolinWorkerConfig;
    spawns.push(config);
    const worker = addWorker(config);
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: NodeJS.Signals) => boolean;
      unref: () => void;
    };
    child.pid = worker.pid;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn().mockReturnValue(true);
    child.unref = vi.fn();
    queueMicrotask(() => {
      child.stdout.write(
        JSON.stringify({
          ready: true,
          sessionId: worker.sessionId,
          socketPath: worker.socketPath,
          workerPid: worker.pid,
          runnerPid: worker.pid + 500,
        }) + "\n",
      );
    });
    return child;
  };

  const connect = (
    socketPath: string,
    callbacks: {
      onJson: (message: object) => void;
      onBinary: (data: Buffer) => void;
      onClose: (error?: Error) => void;
    },
  ) => {
    const worker = workers.get(socketPath);
    if (!worker || !alivePids.has(worker.pid)) {
      queueMicrotask(() =>
        callbacks.onClose(
          Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        ),
      );
      return { send: () => {}, close: () => {} };
    }
    let open = true;
    return {
      send: (message: {
        type: string;
        id: number;
        argv?: string[];
        env?: string[];
        cwd?: string;
      }) => {
        if (!open || message.type !== "exec") return;
        const exec: FakeExec = {
          command: message.argv?.[1] ?? "",
          env: message.env ?? [],
          cwd: message.cwd,
          stdout: (data) => {
            if (open) callbacks.onBinary(frame(1, message.id, data));
          },
          stderr: (data) => {
            if (open) callbacks.onBinary(frame(2, message.id, data));
          },
          respond: (code) => {
            if (open) callbacks.onJson({ type: "exec_response", id: message.id, exit_code: code });
          },
          drop: () => {
            if (open) callbacks.onClose();
          },
        };
        worker.execs.push(exec);
        if (worker.autoRespond) {
          queueMicrotask(() => {
            exec.stdout("ok");
            exec.respond(0);
          });
        }
      },
      close: () => {
        open = false;
      },
    };
  };

  function allExecs(): FakeExec[] {
    return Array.from(workers.values()).flatMap((worker) => worker.execs);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-lifecycle-"));
    nextPid = 40000;
    spawns = [];
    workers = new Map();
    alivePids = new Set();
    signals = [];
    lingerOnSigterm = false;
    gondolin.ensureImageSelector.mockClear();
    gondolinResources.configure();
    gondolinInventory.configure(dir, {
      kill,
      execFile: async () => "node gondolin-worker\n",
      gcSessions: async () => 0,
      killWaitMs: 20,
      killPollIntervalMs: 1,
    });
    gondolinWorkers.configure({
      spawnProcess,
      connect,
      kill,
      handshakeTimeoutMs: 1000,
      stopWaitMs: 2000,
      stopPollIntervalMs: 1,
    });
    Object.defineProperty(process.versions, "node", { value: "24.0.0", configurable: true });
  });

  afterEach(async () => {
    await disconnectAllGondolinRuntimes();
    gondolinWorkers.configure();
    gondolinInventory.configure();
    rmSync(dir, { recursive: true, force: true });
    if (nodeVersion) Object.defineProperty(process.versions, "node", nodeVersion);
    vi.restoreAllMocks();
  });

  test("spawns a worker and runs commands over session IPC", async () => {
    const executor = createExecutor("basic");

    const result = await executor.exec("pwd");

    expect(result).toEqual({ stdout: "ok", stderr: "", code: 0 });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      instanceId: "basic",
      image: "/images/mikan-sandbox:latest",
      mounts: [{ source: "/workspace-host", target: "/workspace" }],
      inventoryDir: dir,
    });
    const exec = allExecs()[0];
    expect(exec.cwd).toBe("/workspace");

    await executor.exec("ls");
    expect(spawns).toHaveLength(1);
    expect(allExecs()).toHaveLength(2);
  });

  test("injects vault env into commands", async () => {
    const executor = createExecutor("env", { GH_TOKEN: "secret" });

    await executor.exec("git fetch");

    const exec = allExecs()[0];
    expect(exec.command).toBe(
      "if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then gh auth setup-git >/dev/null 2>&1 || true; fi\ngit fetch",
    );
    expect(exec.env).toContain("GH_TOKEN=secret");
  });

  test("reads files over the base64 exec transport", async () => {
    const executor = createExecutor("files");
    const worker = { current: undefined as FakeWorker | undefined };
    const spawnOrder = spawns;
    await executor.exec("warm up");
    worker.current = Array.from(workers.values())[0];
    worker.current.autoRespond = false;

    const read = executor.readFile("/workspace/notes.txt");
    await vi.waitFor(() => expect(worker.current?.execs).toHaveLength(2));
    const exec = worker.current.execs[1];
    expect(exec.command).toBe("base64 < '/workspace/notes.txt'");
    exec.stdout(Buffer.from("content").toString("base64"));
    exec.respond(0);
    await expect(read).resolves.toBe("content");
    expect(spawnOrder).toHaveLength(1);
  });

  test("stops an idle worker and spawns a fresh one on the next command", async () => {
    const executor = createExecutor("idle");

    await executor.exec("pwd");
    const worker = Array.from(workers.values())[0];
    await stopIdleGondolinVms(0, Date.now() + 1);

    expect(signals).toContainEqual({ pid: worker.pid, signal: "SIGTERM" });
    expect(existsSync(recordPathFor(worker))).toBe(false);

    await executor.exec("pwd");
    expect(spawns).toHaveLength(2);
  });

  test("does not stop a worker while an operation is active", async () => {
    const executor = createExecutor("active");
    await executor.exec("warm up");
    const worker = Array.from(workers.values())[0];
    worker.autoRespond = false;

    const execution = executor.exec("sleep 1");
    await vi.waitFor(() => expect(worker.execs).toHaveLength(2));
    await stopIdleGondolinVms(0, Date.now() + 1);
    expect(signals).toHaveLength(0);

    worker.execs[1].stdout("done");
    worker.execs[1].respond(0);
    await execution;
    await stopIdleGondolinVms(0, Date.now() + 1);
    expect(signals).toContainEqual({ pid: worker.pid, signal: "SIGTERM" });
  });

  test("serializes an idle close with a concurrent acquire", async () => {
    lingerOnSigterm = true;
    const executor = createExecutor("serialized");
    await executor.exec("pwd");
    const worker = Array.from(workers.values())[0];

    const closing = stopIdleGondolinVms(0, Date.now() + 1);
    const execution = executor.exec("pwd");
    await new Promise((resolve) => setImmediate(resolve));
    expect(signals).toContainEqual({ pid: worker.pid, signal: "SIGTERM" });
    expect(spawns).toHaveLength(1);

    lingerOnSigterm = false;
    alivePids.delete(worker.pid);
    await closing;
    await execution;
    expect(spawns).toHaveLength(2);
  });

  test("recreates the runtime when the desired mounts drift", async () => {
    const original = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "mount-drift",
      mounts: [{ source: "/host/C123", target: "/workspace/C123" }],
    });
    const changed = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "mount-drift",
      mounts: [{ source: "/host", target: "/workspace" }],
    });

    await original.exec("pwd");
    const first = Array.from(workers.values())[0];
    await changed.exec("pwd");
    await changed.exec("pwd");

    expect(signals).toContainEqual({ pid: first.pid, signal: "SIGTERM" });
    expect(spawns).toHaveLength(2);
    expect(spawns[1].mounts).toEqual([{ source: "/host", target: "/workspace" }]);
  });

  test("applies limits and recreates the worker when boosted", async () => {
    gondolinResources.configure({ cpus: "0.5", memory: "512m" }, { cpus: "2", memory: "2g" });
    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "limits",
      resourceKey: "c123",
      workspacePath: "/workspace-host",
    });

    await executor.exec("pwd");
    expect(spawns[0]).toMatchObject({ cpus: 1, memory: "512m" });

    await gondolinResources.boost("c123");
    await executor.exec("pwd");
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toMatchObject({ cpus: 2, memory: "2g" });
    expect(gondolinResources.getLimitStatus("c123").boosted).toBe(true);
  });

  test("rejects an invalid CPU limit before spawning a worker", async () => {
    gondolinResources.configure({ cpus: "invalid" });
    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "invalid-limits",
      resourceKey: "c123",
      workspacePath: "/workspace-host",
    });

    await expect(executor.exec("pwd")).rejects.toThrow(
      "Error: invalid Gondolin CPU limit 'invalid'",
    );
    expect(spawns).toHaveLength(0);
  });

  test("recovers by respawning when the worker died between commands", async () => {
    const executor = createExecutor("crash");
    await executor.exec("pwd");
    const worker = Array.from(workers.values())[0];
    crashWorker(worker);

    const result = await executor.exec("pwd");

    expect(result.code).toBe(0);
    expect(spawns).toHaveLength(2);
    // the hard-crashed worker's record was reaped during recovery
    expect(existsSync(recordPathFor(worker))).toBe(false);
  });

  test("surfaces an interrupted command without dropping a live runtime", async () => {
    const executor = createExecutor("interrupted");
    await executor.exec("warm up");
    const worker = Array.from(workers.values())[0];
    worker.autoRespond = false;

    const execution = executor.exec("long build");
    await vi.waitFor(() => expect(worker.execs).toHaveLength(2));
    worker.execs[1].drop();
    await expect(execution).rejects.toThrow("died");

    await (async () => {
      worker.autoRespond = true;
      const result = await executor.exec("pwd");
      expect(result.code).toBe(0);
    })();
    expect(spawns).toHaveLength(1);
  });

  test("aborts a command via the execution timeout", async () => {
    const executor = createExecutor("timeout");
    await executor.exec("warm up");
    const worker = Array.from(workers.values())[0];
    worker.autoRespond = false;

    await expect(executor.exec("sleep 500", { timeout: 0.05 })).rejects.toThrow("aborted");
    expect(worker.execs).toHaveLength(2);
  });

  test("adopts a surviving worker after a mikan restart", async () => {
    const executor = createExecutor("adopt");
    await executor.exec("pwd");
    const worker = Array.from(workers.values())[0];

    await disconnectAllGondolinRuntimes();
    expect(signals).toHaveLength(0);
    expect(alivePids.has(worker.pid)).toBe(true);

    const result = await executor.exec("ls");
    expect(result.code).toBe(0);
    expect(spawns).toHaveLength(1);
    // adoption probe + the real command
    expect(worker.execs.map((exec) => exec.command)).toEqual(["pwd", "true", "ls"]);
  });

  test("replaces a surviving worker whose fingerprint drifted", async () => {
    const executor = createExecutor("adopt-drift");
    await executor.exec("pwd");
    const worker = Array.from(workers.values())[0];
    await disconnectAllGondolinRuntimes();

    const record = JSON.parse(readFileSync(recordPathFor(worker), "utf8"));
    writeFileSync(recordPathFor(worker), JSON.stringify({ ...record, fingerprint: "stale" }));

    await executor.exec("ls");
    expect(signals).toContainEqual({ pid: worker.pid, signal: "SIGTERM" });
    expect(spawns).toHaveLength(2);
  });

  test("sweeps surviving workers that no conversation adopted", async () => {
    const adopted = createExecutor("adopted-key");
    await adopted.exec("pwd");
    const orphan = addWorker({
      instanceId: "quiet-key",
      image: "/images/mikan-sandbox:latest",
      mounts: [],
      fingerprint: "fp",
      inventoryDir: dir,
      heartbeatStaleMs: 0,
    });

    await sweepUnadoptedGondolinWorkers();

    expect(signals).toContainEqual({ pid: orphan.pid, signal: "SIGTERM" });
    const survivor = Array.from(workers.values())[0];
    expect(signals).not.toContainEqual({ pid: survivor.pid, signal: "SIGTERM" });
  });

  test("spawns again after a worker fails to start", async () => {
    const originalSpawn = spawnProcess;
    let failFirst = true;
    gondolinWorkers.configure({
      spawnProcess: (command, args) => {
        if (!failFirst) return originalSpawn(command, args);
        failFirst = false;
        const child = new EventEmitter() as ReturnType<typeof spawnProcess>;
        child.pid = 39999;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = vi.fn().mockReturnValue(true);
        child.unref = vi.fn();
        queueMicrotask(() => {
          child.stdout.write(JSON.stringify({ ready: false, error: "boot failed" }) + "\n");
        });
        return child;
      },
      connect,
      kill,
      handshakeTimeoutMs: 1000,
      stopWaitMs: 50,
      stopPollIntervalMs: 1,
    });
    const executor = createExecutor("retry");

    await expect(executor.exec("pwd")).rejects.toThrow("boot failed");
    await expect(executor.exec("pwd")).resolves.toEqual({ stdout: "ok", stderr: "", code: 0 });
  });

  test("keeps workers running through a mikan shutdown", async () => {
    await createExecutor("one").exec("pwd");
    await createExecutor("two").exec("pwd");

    await disconnectAllGondolinRuntimes();

    expect(signals).toHaveLength(0);
    expect(alivePids.size).toBe(2);
    for (const worker of workers.values()) {
      expect(existsSync(recordPathFor(worker))).toBe(true);
    }
    expect(readdirSync(dir).filter((file) => file.endsWith(".json"))).toHaveLength(2);
  });

  test("rejects new work while shutting down", async () => {
    const executor = createExecutor("late");
    await executor.exec("warm up");
    const worker = Array.from(workers.values())[0];
    worker.autoRespond = false;

    const execution = executor.exec("slow");
    await vi.waitFor(() => expect(worker.execs).toHaveLength(2));
    const closing = disconnectAllGondolinRuntimes();
    await expect(createExecutor("late").exec("pwd")).rejects.toThrow(
      "Error: Gondolin runtime is shutting down",
    );

    worker.execs[1].respond(0);
    await execution;
    await closing;
  });
});
