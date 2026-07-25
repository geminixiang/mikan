import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const gondolin = vi.hoisted(() => ({
  ensureImageSelector: vi.fn(),
  createVm: vi.fn(),
  findSession: vi.fn(),
  connectToSession: vi.fn(),
  gcSessions: vi.fn(),
}));

vi.mock("@earendil-works/gondolin", () => ({
  ensureImageSelector: gondolin.ensureImageSelector,
  findSession: gondolin.findSession,
  connectToSession: gondolin.connectToSession,
  gcSessions: gondolin.gcSessions,
  VM: { create: gondolin.createVm },
  RealFSProvider: class {
    constructor(public source: string) {}
  },
  ReadonlyProvider: class {
    constructor(public backend: { source: string }) {}
  },
}));

import {
  GondolinExecutor,
  gondolinResources,
  stopAllGondolinRuntimes,
  stopIdleGondolinVms,
} from "../src/sandbox/gondolin.js";

/** The `/workspace` mount sync interval inside gondolin.ts. */
const PROJECTION_SYNC_INTERVAL_MS = 2000;

interface FakeExec {
  command: string;
  env: string[];
  cwd?: string;
  respond: (code: number) => void;
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  drop: () => void;
}

interface VmOptions {
  sandbox: { imagePath: string };
  cpus?: number;
  memory?: string;
  sessionLabel: string;
  vfs: { mounts: Record<string, { source?: string; constructor: { name: string } }> };
}

interface FakeVm {
  id: string;
  socketPath: string;
  options: VmOptions;
  /** Commands received over the session socket. */
  execs: FakeExec[];
  /** Direct `vm.exec()` calls (credential chmod). */
  guestExecs: string[];
  guestFiles: Map<string, Buffer>;
  alive: boolean;
  closed: boolean;
  autoRespond: boolean;
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
  let workspaceHost: string;
  let vms: FakeVm[];
  let bySocket: Map<string, FakeVm>;
  let nextVm: number;
  let failNextBoot: string | undefined;
  let lingerOnClose: boolean;
  let pendingCloses: Array<() => void>;

  function createExecutor(instanceId: string, env?: Record<string, string>): GondolinExecutor {
    return new GondolinExecutor(
      { type: "gondolin", profile: "default", instanceId, workspacePath: workspaceHost },
      env,
    );
  }

  function makeVm(options: VmOptions): FakeVm {
    nextVm += 1;
    const vm: FakeVm = {
      id: `vm-${nextVm}`,
      socketPath: join(dir, `vm-${nextVm}.sock`),
      options,
      execs: [],
      guestExecs: [],
      guestFiles: new Map(),
      alive: true,
      closed: false,
      autoRespond: true,
    };
    vms.push(vm);
    bySocket.set(vm.socketPath, vm);
    return vm;
  }

  /** The VM handle the production code sees. */
  function vmHandle(vm: FakeVm) {
    return {
      id: vm.id,
      start: vi.fn(async () => {
        if (failNextBoot) {
          const message = failNextBoot;
          failNextBoot = undefined;
          throw new Error(message);
        }
      }),
      close: vi.fn(async () => {
        vm.closed = true;
        vm.alive = false;
        if (lingerOnClose) await new Promise<void>((resolve) => pendingCloses.push(resolve));
      }),
      getHostPid: vi.fn(() => (vm.alive ? 5000 + nextVm : null)),
      exec: vi.fn(async (command: string) => {
        vm.guestExecs.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      fs: {
        mkdir: vi.fn(async () => {}),
        writeFile: vi.fn(async (path: string, data: Buffer) => {
          vm.guestFiles.set(path, Buffer.from(data));
        }),
        readFile: vi.fn(async (path: string) => {
          const content = vm.guestFiles.get(path);
          if (!content) throw new Error("ENOENT");
          return content;
        }),
      },
    };
  }

  const connect = (
    socketPath: string,
    callbacks: {
      onJson: (message: object) => void;
      onBinary: (data: Buffer) => void;
      onClose: (error?: Error) => void;
    },
  ) => {
    const vm = bySocket.get(socketPath);
    if (!vm || !vm.alive) {
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
        vm.execs.push(exec);
        if (vm.autoRespond) {
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
    return vms.flatMap((vm) => vm.execs);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-lifecycle-"));
    workspaceHost = join(dir, "ws");
    mkdirSync(workspaceHost, { recursive: true });
    vms = [];
    bySocket = new Map();
    nextVm = 0;
    failNextBoot = undefined;
    lingerOnClose = false;
    pendingCloses = [];
    gondolin.ensureImageSelector.mockImplementation(async (selector: string) => ({
      assetDir: `/images/${selector}`,
      buildId: selector,
    }));
    gondolin.createVm.mockImplementation(async (options: VmOptions) => vmHandle(makeVm(options)));
    gondolin.findSession.mockImplementation(async (id: string) => {
      const vm = vms.find((entry) => entry.id === id);
      return vm ? { id, socketPath: vm.socketPath, alive: true } : null;
    });
    gondolin.connectToSession.mockImplementation(connect);
    gondolin.gcSessions.mockResolvedValue(0);
    gondolinResources.configure();
    Object.defineProperty(process.versions, "node", { value: "24.0.0", configurable: true });
  });

  afterEach(async () => {
    lingerOnClose = false;
    for (const resolve of pendingCloses.splice(0)) resolve();
    await stopAllGondolinRuntimes();
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
    if (nodeVersion) Object.defineProperty(process.versions, "node", nodeVersion);
    vi.restoreAllMocks();
  });

  test("boots a VM and runs commands over its session socket", async () => {
    const executor = createExecutor("basic");

    const result = await executor.exec("pwd");

    expect(result).toEqual({ stdout: "ok", stderr: "", code: 0 });
    expect(vms).toHaveLength(1);
    expect(vms[0].options).toMatchObject({
      sandbox: { imagePath: "/images/mikan-sandbox:latest" },
      sessionLabel: "mikan:basic",
    });
    expect(Object.keys(vms[0].options.vfs.mounts)).toEqual(["/workspace"]);
    expect(allExecs()[0].cwd).toBe("/workspace");

    await executor.exec("ls");
    expect(vms).toHaveLength(1);
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
    await executor.exec("warm up");
    const vm = vms[0];
    vm.autoRespond = false;

    const read = executor.readFile("/workspace/notes.txt");
    await vi.waitFor(() => expect(vm.execs).toHaveLength(2));
    const exec = vm.execs[1];
    expect(exec.command).toBe("base64 < '/workspace/notes.txt'");
    exec.stdout(Buffer.from("content").toString("base64"));
    exec.respond(0);

    await expect(read).resolves.toBe("content");
    expect(vms).toHaveLength(1);
  });

  test("stops an idle VM and creates a fresh one on the next command", async () => {
    const executor = createExecutor("idle");

    await executor.exec("pwd");
    const vm = vms[0];
    await stopIdleGondolinVms(0, Date.now() + 1);

    expect(vm.closed).toBe(true);

    await executor.exec("pwd");
    expect(vms).toHaveLength(2);
  });

  test("does not close a VM while an operation is active", async () => {
    const executor = createExecutor("active");
    await executor.exec("warm up");
    const vm = vms[0];
    vm.autoRespond = false;

    const execution = executor.exec("sleep 1");
    await vi.waitFor(() => expect(vm.execs).toHaveLength(2));
    await stopIdleGondolinVms(0, Date.now() + 1);
    expect(vm.closed).toBe(false);

    vm.execs[1].stdout("done");
    vm.execs[1].respond(0);
    await execution;
    await stopIdleGondolinVms(0, Date.now() + 1);
    expect(vm.closed).toBe(true);
  });

  test("serializes an idle close with a concurrent acquire", async () => {
    lingerOnClose = true;
    const executor = createExecutor("serialized");
    await executor.exec("pwd");

    const closing = stopIdleGondolinVms(0, Date.now() + 1);
    const execution = executor.exec("pwd");
    await new Promise((resolve) => setImmediate(resolve));
    expect(vms).toHaveLength(1);

    lingerOnClose = false;
    for (const resolve of pendingCloses.splice(0)) resolve();
    await closing;
    await execution;
    expect(vms).toHaveLength(2);
  });

  test("recreates the runtime when the desired mounts drift", async () => {
    const scoped = join(workspaceHost, "C123");
    mkdirSync(scoped, { recursive: true });
    const original = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "mount-drift",
      mounts: [{ source: scoped, target: "/workspace/C123" }],
    });
    const changed = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "mount-drift",
      mounts: [{ source: workspaceHost, target: "/workspace" }],
    });

    await original.exec("pwd");
    const first = vms[0];
    await changed.exec("pwd");
    await changed.exec("pwd");

    expect(first.closed).toBe(true);
    expect(vms).toHaveLength(2);
    expect(Object.keys(vms[1].options.vfs.mounts)).toEqual(["/workspace"]);
  });

  test("recreates the runtime when a projected credential rotates on the host", async () => {
    const credential = join(dir, "gws.json");
    writeFileSync(credential, '{"refresh_token":"old"}');
    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "credential-drift",
      workspacePath: workspaceHost,
      mounts: [
        { source: workspaceHost, target: "/workspace" },
        { source: credential, target: "/root/.config/gws/credentials.json" },
      ],
    });

    await executor.exec("pwd");
    await executor.exec("pwd");
    expect(vms).toHaveLength(1);

    writeFileSync(credential, '{"refresh_token":"fresh"}'); // host re-login
    await executor.exec("pwd");

    expect(vms[0].closed).toBe(true);
    expect(vms).toHaveLength(2);
    expect(vms[1].guestFiles.get("/root/.config/gws/credentials.json")?.toString()).toBe(
      '{"refresh_token":"fresh"}',
    );
  });

  test("guest writes to workspace files do not drift the runtime", async () => {
    const memory = join(workspaceHost, "MEMORY.md");
    writeFileSync(memory, "v1");
    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "memory-no-drift",
      workspacePath: workspaceHost,
      mounts: [{ source: memory, target: "/workspace/MEMORY.md" }],
    });

    await executor.exec("pwd");
    writeFileSync(memory, "v2 synced back from the guest");
    await executor.exec("pwd");

    expect(vms).toHaveLength(1);
    expect(vms[0].closed).toBe(false);
  });

  test("applies limits and recreates the VM when boosted", async () => {
    gondolinResources.configure({ cpus: "0.5", memory: "512m" }, { cpus: "2", memory: "2g" });
    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "limits",
      resourceKey: "c123",
      workspacePath: workspaceHost,
    });

    await executor.exec("pwd");
    expect(vms[0].options).toMatchObject({ cpus: 1, memory: "512m" });

    await gondolinResources.boost("c123");
    await executor.exec("pwd");
    expect(vms).toHaveLength(2);
    expect(vms[1].options).toMatchObject({ cpus: 2, memory: "2g" });
    expect(gondolinResources.getLimitStatus("c123").boosted).toBe(true);
  });

  test("rejects an invalid CPU limit before creating a VM", async () => {
    gondolinResources.configure({ cpus: "invalid" });
    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "invalid-limits",
      resourceKey: "c123",
      workspacePath: workspaceHost,
    });

    await expect(executor.exec("pwd")).rejects.toThrow(
      "Error: invalid Gondolin CPU limit 'invalid'",
    );
    expect(vms).toHaveLength(0);
  });

  test("recovers by recreating the runtime when the VM died between commands", async () => {
    const executor = createExecutor("crash");
    await executor.exec("pwd");
    vms[0].alive = false; // the runner died under us

    const result = await executor.exec("pwd");

    expect(result.code).toBe(0);
    expect(vms).toHaveLength(2);
  });

  test("surfaces an interrupted command without dropping a live runtime", async () => {
    const executor = createExecutor("interrupted");
    await executor.exec("warm up");
    const vm = vms[0];
    vm.autoRespond = false;

    const execution = executor.exec("long build");
    await vi.waitFor(() => expect(vm.execs).toHaveLength(2));
    vm.execs[1].drop();
    await expect(execution).rejects.toThrow("died");

    vm.autoRespond = true;
    await expect(executor.exec("pwd")).resolves.toMatchObject({ code: 0 });
    expect(vms).toHaveLength(1);
  });

  test("aborts a command via the execution timeout", async () => {
    const executor = createExecutor("timeout");
    await executor.exec("warm up");
    const vm = vms[0];
    vm.autoRespond = false;

    await expect(executor.exec("sleep 500", { timeout: 0.05 })).rejects.toThrow("aborted");
    expect(vm.execs).toHaveLength(2);
  });

  test("closes a half-booted VM and creates a new one on the next command", async () => {
    failNextBoot = "boot wedged";
    const executor = createExecutor("retry");

    await expect(executor.exec("pwd")).rejects.toThrow("boot wedged");
    expect(vms[0].closed).toBe(true);

    await expect(executor.exec("pwd")).resolves.toEqual({ stdout: "ok", stderr: "", code: 0 });
    expect(vms).toHaveLength(2);
  });

  test("projects file mounts into the guest instead of VFS-mounting them", async () => {
    const scoped = join(workspaceHost, "C123");
    mkdirSync(scoped, { recursive: true });
    const memory = join(workspaceHost, "MEMORY.md");
    writeFileSync(memory, "remember me");
    const credential = join(dir, "credentials.json");
    writeFileSync(credential, "{token}");

    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "projection",
      workspacePath: workspaceHost,
      mounts: [
        { source: memory, target: "/workspace/MEMORY.md" },
        { source: scoped, target: "/workspace/C123" },
        { source: credential, target: "/root/.config/gws/credentials.json" },
      ],
    });
    await executor.exec("pwd");

    // only the directory reaches the VFS — file targets cannot guest-bind
    expect(Object.keys(vms[0].options.vfs.mounts)).toEqual(["/workspace/C123"]);
    expect(vms[0].guestFiles.get("/workspace/MEMORY.md")?.toString()).toBe("remember me");
    expect(vms[0].guestFiles.get("/root/.config/gws/credentials.json")?.toString()).toBe("{token}");
    // the credential is projected owner-only and never synced back
    expect(vms[0].guestExecs).toEqual(["chmod 600 '/root/.config/gws/credentials.json'"]);
  });

  test("wraps a read-only mount in ReadonlyProvider and leaves the rest writable", async () => {
    const scoped = join(workspaceHost, "C123");
    mkdirSync(scoped, { recursive: true });
    const packageSkills = join(dir, "pkg-skills");
    mkdirSync(packageSkills, { recursive: true });

    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "readonly",
      workspacePath: workspaceHost,
      mounts: [
        { source: scoped, target: "/workspace/C123" },
        { source: packageSkills, target: "/mikan/packages/example/skills", readOnly: true },
      ],
    });
    await executor.exec("pwd");

    const mounts = vms[0].options.vfs.mounts;
    expect(mounts["/mikan/packages/example/skills"].constructor.name).toBe("ReadonlyProvider");
    // The agent's own conversation directory must stay writable.
    expect(mounts["/workspace/C123"].constructor.name).toBe("RealFSProvider");
  });

  test("a read-only flag flip recreates the runtime", async () => {
    const packageSkills = join(dir, "pkg-skills");
    mkdirSync(packageSkills, { recursive: true });
    const base = {
      type: "gondolin" as const,
      profile: "default" as const,
      instanceId: "readonly-drift",
      workspacePath: workspaceHost,
    };
    const readOnly = new GondolinExecutor({
      ...base,
      mounts: [{ source: packageSkills, target: "/mikan/packages/example/skills", readOnly: true }],
    });
    const writable = new GondolinExecutor({
      ...base,
      mounts: [{ source: packageSkills, target: "/mikan/packages/example/skills" }],
    });

    await readOnly.exec("pwd");
    await writable.exec("pwd");

    expect(vms).toHaveLength(2);
    expect(vms[0].closed).toBe(true);
  });

  test("syncs workspace file edits back to the host while the VM runs", async () => {
    vi.useFakeTimers();
    const memory = join(workspaceHost, "MEMORY.md");
    writeFileSync(memory, "v1");
    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "sync",
      workspacePath: workspaceHost,
      mounts: [{ source: memory, target: "/workspace/MEMORY.md" }],
    });
    await executor.exec("pwd");

    vms[0].guestFiles.set("/workspace/MEMORY.md", Buffer.from("v2 from guest"));
    await vi.advanceTimersByTimeAsync(PROJECTION_SYNC_INTERVAL_MS);

    expect(readFileSync(memory, "utf8")).toBe("v2 from guest");
  });

  test("makes a final sync when the runtime closes", async () => {
    const memory = join(workspaceHost, "MEMORY.md");
    writeFileSync(memory, "v1");
    const executor = new GondolinExecutor({
      type: "gondolin",
      profile: "default",
      instanceId: "final-sync",
      workspacePath: workspaceHost,
      mounts: [{ source: memory, target: "/workspace/MEMORY.md" }],
    });
    await executor.exec("pwd");

    vms[0].guestFiles.set("/workspace/MEMORY.md", Buffer.from("final state"));
    await stopIdleGondolinVms(0, Date.now() + 1);

    expect(vms[0].closed).toBe(true);
    expect(readFileSync(memory, "utf8")).toBe("final state");
  });

  test("closes every runtime on shutdown", async () => {
    await createExecutor("one").exec("pwd");
    await createExecutor("two").exec("pwd");

    await stopAllGondolinRuntimes();

    expect(vms).toHaveLength(2);
    for (const vm of vms) expect(vm.closed).toBe(true);
  });

  test("rejects new work while shutting down", async () => {
    const executor = createExecutor("late");
    await executor.exec("warm up");
    const vm = vms[0];
    vm.autoRespond = false;

    const execution = executor.exec("slow");
    await vi.waitFor(() => expect(vm.execs).toHaveLength(2));
    const closing = stopAllGondolinRuntimes();
    await expect(createExecutor("late").exec("pwd")).rejects.toThrow(
      "Error: Gondolin runtime is shutting down",
    );

    vm.execs[1].respond(0);
    await execution;
    await closing;
  });
});
