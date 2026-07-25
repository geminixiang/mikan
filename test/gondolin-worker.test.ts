import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runGondolinWorker, type GondolinWorkerConfig } from "../src/sandbox/gondolin-worker.js";
import { gondolinInventory } from "../src/sandbox/gondolin-inventory.js";

function createFakeVm() {
  const guestFiles = new Map<string, Buffer>();
  return {
    id: "vm-1",
    guestFiles,
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getHostPid: vi.fn().mockReturnValue(777),
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    fs: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn(async (path: string, data: Buffer) => {
        guestFiles.set(path, Buffer.from(data));
      }),
      readFile: vi.fn(async (path: string) => {
        const content = guestFiles.get(path);
        if (!content) throw new Error("ENOENT");
        return content;
      }),
    },
  };
}

describe("Gondolin worker runtime", () => {
  let dir: string;
  let vm: ReturnType<typeof createFakeVm>;
  let created: object[];
  let announced: string[];
  let exitCodes: number[];
  const signalSnapshot = new Map<NodeJS.Signals, NodeJS.SignalsListener[]>();

  const loadGondolin = async () =>
    ({
      VM: {
        create: vi.fn(async (options: object) => {
          created.push(options);
          return vm;
        }),
      },
      RealFSProvider: class {
        constructor(public source: string) {}
      },
      ReadonlyProvider: class {
        constructor(public backend: { source: string }) {}
      },
      findSession: vi.fn(async (id: string) => ({
        id,
        pid: process.pid,
        socketPath: join(dir, `${id}.sock`),
        createdAt: new Date().toISOString(),
        alive: true,
      })),
    }) as never;

  function config(overrides: Partial<GondolinWorkerConfig> = {}): GondolinWorkerConfig {
    return {
      instanceId: "c1",
      image: "/images/mikan",
      mounts: [{ source: "/host", target: "/workspace" }],
      fingerprint: "fp-1",
      inventoryDir: dir,
      heartbeatStaleMs: 0,
      ...overrides,
    };
  }

  function run(overrides: Partial<GondolinWorkerConfig> = {}): Promise<void> {
    return runGondolinWorker(config(overrides), {
      loadGondolin,
      announce: (line) => announced.push(line),
      exit: (code) => exitCodes.push(code),
      pollIntervalMs: 5,
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-worker-"));
    vm = createFakeVm();
    created = [];
    announced = [];
    exitCodes = [];
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      signalSnapshot.set(signal, process.listeners(signal) as NodeJS.SignalsListener[]);
    }
  });

  afterEach(async () => {
    // stop any watchdog still running, then restore foreign signal listeners
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exitCodes.length).toBeGreaterThan(0));
    for (const [signal, listeners] of signalSnapshot) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.includes(listener as NodeJS.SignalsListener)) {
          process.removeListener(signal, listener);
        }
      }
    }
    gondolinInventory.configure();
    rmSync(dir, { recursive: true, force: true });
  });

  test("boots the VM, records the runtime, and announces readiness", async () => {
    await run();

    expect(vm.start).toHaveBeenCalledOnce();
    expect(created[0]).toMatchObject({
      sandbox: { imagePath: "/images/mikan" },
      sessionLabel: "mikan:c1",
    });
    expect(JSON.parse(announced[0])).toMatchObject({
      ready: true,
      sessionId: "vm-1",
      workerPid: process.pid,
      runnerPid: 777,
    });
    const record = JSON.parse(readFileSync(join(dir, "vm-1.json"), "utf8"));
    expect(record).toMatchObject({
      sessionId: "vm-1",
      instanceId: "c1",
      ownerPid: process.pid,
      runnerPid: 777,
      fingerprint: "fp-1",
    });
    expect(record.socketPath).toContain("vm-1.sock");
  });

  test("shuts down cleanly on SIGTERM", async () => {
    await run();

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
    expect(vm.close).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, "vm-1.json"))).toBe(false);
  });

  test("exits when the VM runner dies", async () => {
    await run();

    vm.getHostPid.mockReturnValue(null);
    await vi.waitFor(() => expect(exitCodes).toEqual([1]));
    expect(vm.close).toHaveBeenCalledOnce();
    expect(existsSync(join(dir, "vm-1.json"))).toBe(false);
  });

  test("refreshes the record when the runner pid changes", async () => {
    await run();

    vm.getHostPid.mockReturnValue(888);
    await vi.waitFor(() => {
      const record = JSON.parse(readFileSync(join(dir, "vm-1.json"), "utf8"));
      expect(record.runnerPid).toBe(888);
    });
  });

  test("self-stops once the mikan heartbeat goes stale", async () => {
    await run({ heartbeatStaleMs: 40 });

    await vi.waitFor(() => expect(exitCodes).toEqual([0]), { timeout: 2000 });
    expect(vm.close).toHaveBeenCalledOnce();
  });

  test("projects file mounts into the guest instead of VFS-mounting them", async () => {
    const workspace = join(dir, "ws");
    mkdirSync(join(workspace, "C123"), { recursive: true });
    writeFileSync(join(workspace, "MEMORY.md"), "remember me");
    const credential = join(dir, "credentials.json");
    writeFileSync(credential, "{token}");

    await run({
      mounts: [
        { source: join(workspace, "MEMORY.md"), target: "/workspace/MEMORY.md" },
        { source: join(workspace, "C123"), target: "/workspace/C123" },
        { source: credential, target: "/root/.config/gws/credentials.json" },
      ],
    });

    // only the directory reaches the VFS — file targets cannot guest-bind
    const options = created[0] as { vfs: { mounts: Record<string, unknown> } };
    expect(Object.keys(options.vfs.mounts)).toEqual(["/workspace/C123"]);

    expect(vm.guestFiles.get("/workspace/MEMORY.md")?.toString()).toBe("remember me");
    expect(vm.guestFiles.get("/root/.config/gws/credentials.json")?.toString()).toBe("{token}");
    // credential is projected owner-only and never synced back
    expect(vm.exec).toHaveBeenCalledWith("chmod 600 '/root/.config/gws/credentials.json'");
    expect(vm.exec).toHaveBeenCalledTimes(1);
  });

  test("wraps a read-only mount in ReadonlyProvider and leaves the rest writable", async () => {
    const workspace = join(dir, "ws");
    mkdirSync(join(workspace, "C123"), { recursive: true });
    const packageSkills = join(dir, "pkg-skills");
    mkdirSync(packageSkills, { recursive: true });

    await run({
      mounts: [
        { source: join(workspace, "C123"), target: "/workspace/C123" },
        { source: packageSkills, target: "/mikan/packages/example/skills", readOnly: true },
      ],
    });

    const options = created[0] as {
      vfs: { mounts: Record<string, { constructor: { name: string } }> };
    };
    expect(options.vfs.mounts["/mikan/packages/example/skills"].constructor.name).toBe(
      "ReadonlyProvider",
    );
    // The agent's own conversation directory must stay writable.
    expect(options.vfs.mounts["/workspace/C123"].constructor.name).toBe("RealFSProvider");
  });

  test("syncs workspace file edits back to the host", async () => {
    const workspace = join(dir, "ws");
    mkdirSync(workspace, { recursive: true });
    const memory = join(workspace, "MEMORY.md");
    writeFileSync(memory, "v1");

    await run({ mounts: [{ source: memory, target: "/workspace/MEMORY.md" }] });

    vm.guestFiles.set("/workspace/MEMORY.md", Buffer.from("v2 from guest"));
    await vi.waitFor(() => expect(readFileSync(memory, "utf8")).toBe("v2 from guest"));
  });

  test("makes a final sync during shutdown", async () => {
    const workspace = join(dir, "ws");
    mkdirSync(workspace, { recursive: true });
    const memory = join(workspace, "MEMORY.md");
    writeFileSync(memory, "v1");
    await runGondolinWorker(
      config({ mounts: [{ source: memory, target: "/workspace/MEMORY.md" }] }),
      {
        loadGondolin,
        announce: (line) => announced.push(line),
        exit: (code) => exitCodes.push(code),
        pollIntervalMs: 60_000, // periodic sync never fires; shutdown must
      },
    );

    vm.guestFiles.set("/workspace/MEMORY.md", Buffer.from("final state"));
    process.emit("SIGTERM");
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
    expect(readFileSync(memory, "utf8")).toBe("final state");
  });

  test("closes the VM when boot fails after create", async () => {
    vm.start.mockRejectedValueOnce(new Error("boot wedged"));

    await expect(run()).rejects.toThrow("boot wedged");
    expect(vm.close).toHaveBeenCalledOnce();
    process.emit("SIGTERM"); // satisfy the afterEach exit wait
    exitCodes.push(0);
  });
});
