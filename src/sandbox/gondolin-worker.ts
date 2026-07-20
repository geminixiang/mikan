import { createHash } from "node:crypto";
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gondolinInventory } from "./gondolin-inventory.js";
import { shellEscape } from "./utils.js";

type GondolinModule = typeof import("@earendil-works/gondolin");

// The argv config and handshake are wire contract shapes shared with the Go
// daemon; their single home is gondolin-contract.ts (re-exported here for
// the worker entrypoint and spawners).
export type { GondolinWorkerConfig, GondolinWorkerHandshake } from "./gondolin-contract.js";
import type { GondolinWorkerConfig, GondolinWorkerHandshake } from "./gondolin-contract.js";

interface GondolinWorkerDeps {
  loadGondolin?: () => Promise<GondolinModule>;
  announce?: (line: string) => void;
  exit?: (code: number) => void;
  pollIntervalMs?: number;
  fencingCloseTimeoutMs?: number;
  killRunner?: (pid: number) => boolean;
  monotonicNow?: () => number;
}

/**
 * A single-file mount handled outside the VFS: Gondolin's guest prepares every
 * VFS mount point with `mkdir -p`, so a file target can never bind (the guest
 * ends up bind-mounting a file onto a directory and the VM refuses to start).
 * Files are copied in after boot instead; the ones under /workspace sync guest
 * edits back to the host so agent-maintained files like MEMORY.md persist.
 */
interface FileProjection {
  source: string;
  target: string;
  syncBack: boolean;
  lastHash: string;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function warn(message: string): void {
  process.stderr.write(`[gondolin-worker] ${message}\n`);
}

function heartbeatFresh(
  path: string,
  tracker: { signature?: string; observedAt: number },
  staleMs: number,
  monotonicNow: () => number,
): boolean {
  try {
    const signature = readFileSync(path, "utf8");
    if (signature !== tracker.signature) {
      tracker.signature = signature;
      tracker.observedAt = monotonicNow();
    }
  } catch {
    // no heartbeat yet — the local monotonic start remains authoritative
  }
  return monotonicNow() - tracker.observedAt <= staleMs;
}

function restrictSocketAccess(socketPath: string): void {
  // The session socket grants arbitrary exec inside the VM (and through its
  // mounts, the workspace) — keep it to this user even under a lax umask.
  try {
    chmodSync(dirname(socketPath), 0o700);
    chmodSync(socketPath, 0o600);
  } catch {
    // best-effort hardening
  }
}

function partitionMounts(mounts: GondolinWorkerConfig["mounts"]): {
  directories: GondolinWorkerConfig["mounts"];
  files: FileProjection[];
} {
  const directories: GondolinWorkerConfig["mounts"] = [];
  const files: FileProjection[] = [];
  for (const mount of mounts) {
    let isDirectory: boolean;
    try {
      isDirectory = statSync(mount.source).isDirectory();
    } catch {
      warn(`skipping missing mount source ${mount.source}`);
      continue;
    }
    if (isDirectory) {
      directories.push(mount);
    } else {
      files.push({
        ...mount,
        syncBack: mount.target.startsWith("/workspace/"),
        lastHash: "",
      });
    }
  }
  return { directories, files };
}

/**
 * Host one Gondolin VM for its whole life: boot it, persist the inventory
 * record other processes adopt it through, announce readiness on stdout, then
 * watch the VM runner and shut down when it dies, when a SIGTERM arrives, or
 * when every mikan that could adopt the runtime is gone (stale heartbeat).
 */
export async function runGondolinWorker(
  config: GondolinWorkerConfig,
  deps: GondolinWorkerDeps = {},
): Promise<void> {
  const announce = deps.announce ?? ((line: string) => process.stdout.write(line + "\n"));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const pollIntervalMs = deps.pollIntervalMs ?? 2000;
  const fencingCloseTimeoutMs = deps.fencingCloseTimeoutMs ?? 10_000;
  const killRunner =
    deps.killRunner ??
    ((pid: number): boolean => {
      try {
        process.kill(pid, "SIGKILL");
        return true;
      } catch {
        return true; // already gone
      }
    });
  const loadGondolin =
    deps.loadGondolin ?? (() => import("@earendil-works/gondolin") as Promise<GondolinModule>);

  gondolinInventory.configure(config.inventoryDir);
  const { VM, RealFSProvider, createHttpHooks, findSession, ensureImageSelector } =
    await loadGondolin();
  let imagePath = config.image;
  if (!imagePath) {
    if (!config.imageSelector) throw new Error("worker config needs image or imageSelector");
    imagePath = (await ensureImageSelector(config.imageSelector)).assetDir;
  }
  const { directories, files } = partitionMounts(config.mounts);
  const network = config.network ? createHttpHooks(config.network) : undefined;
  const vm = await VM.create({
    sandbox: { imagePath },
    ...(network ? { httpHooks: network.httpHooks } : {}),
    env: { TZ: "Asia/Taipei" },
    sessionLabel: `mikan:${config.instanceId}`,
    cpus: config.cpus,
    memory: config.memory,
    vfs: {
      mounts: Object.fromEntries(
        directories.map(({ source, target }) => [target, new RealFSProvider(source)]),
      ),
    },
  });

  let session: Awaited<ReturnType<typeof findSession>>;
  try {
    await vm.start();
    await projectFiles(vm, files);
    session = await findSession(vm.id);
    if (!session) throw new Error(`Gondolin session '${vm.id}' did not register`);
  } catch (error) {
    // never leave a half-booted runner (and its overlay disk) behind
    await vm.close().catch(() => {});
    throw error;
  }
  restrictSocketAccess(session.socketPath);
  gondolinInventory.record({
    sessionId: vm.id,
    instanceId: config.instanceId,
    runnerPid: vm.getHostPid(),
    socketPath: session.socketPath,
    fingerprint: config.fingerprint,
  });

  const monotonicNow = deps.monotonicNow ?? performance.now.bind(performance);
  const heartbeatTracker = { observedAt: monotonicNow() };
  let closing = false;
  let syncGeneration = 0;
  let syncTask: Promise<void> | undefined;
  const syncProjections = (allowClosing = false): Promise<void> => {
    if (syncTask) return syncTask;
    if (closing && !allowClosing) return Promise.resolve();
    const generation = syncGeneration;
    syncTask = (async () => {
      for (const projection of files) {
        if (!projection.syncBack || generation !== syncGeneration) continue;
        try {
          const data = await vm.fs.readFile(projection.target);
          // A fencing shutdown may have closed the VM while this read was in
          // flight. Never publish its stale result into the host workspace.
          if (generation !== syncGeneration) return;
          const content = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
          const hash = sha256(content);
          if (hash === projection.lastHash) continue;
          // atomic host write: a crash mid-sync must not truncate the file
          const staged = `${projection.source}.mikan-sync`;
          writeFileSync(staged, content);
          renameSync(staged, projection.source);
          projection.lastHash = hash;
        } catch {
          // guest file missing or read raced a writer; next tick retries
        }
      }
    })().finally(() => {
      syncTask = undefined;
    });
    return syncTask;
  };

  const shutdown = async (
    code: number,
    options: { syncBeforeClose?: boolean; fence?: boolean } = {},
  ): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(watchdog);
    if (options.fence) syncGeneration += 1;
    if (options.syncBeforeClose !== false) {
      try {
        await syncProjections(true);
      } catch {
        // best effort; the periodic sync already captured earlier edits
      }
    }
    let fencingFailure = false;
    try {
      const close = Promise.resolve(vm.close());
      if (options.fence) {
        let timedOut = false;
        let timeout: NodeJS.Timeout | undefined;
        await Promise.race([
          close,
          new Promise<void>((resolve) => {
            timeout = setTimeout(() => {
              timedOut = true;
              resolve();
            }, fencingCloseTimeoutMs);
            timeout.unref?.();
          }),
        ]);
        clearTimeout(timeout);
        if (timedOut) {
          const runnerPid = vm.getHostPid();
          if (runnerPid !== null && !killRunner(runnerPid)) fencingFailure = true;
          void close.catch(() => {});
        }
      } else {
        await close;
      }
    } catch {
      // the runner may already be gone
    }
    if (fencingFailure) {
      // Keep the inventory record so the daemon's verified orphan reaper can
      // retry. Never claim a clean fence when PID identity was ambiguous.
      exit(1);
      return;
    }
    gondolinInventory.release(vm.id);
    exit(code);
  };

  const watchdog = setInterval(() => {
    const runnerPid = vm.getHostPid();
    if (runnerPid === null) {
      // The VM runner died under us; exit so mikan sees the socket close and
      // recreates the runtime instead of hanging on a silent session.
      void shutdown(1);
      return;
    }
    gondolinInventory.refresh(vm.id, runnerPid);
    void syncProjections();
    const heartbeat = gondolinInventory.heartbeatPath();
    if (
      config.heartbeatStaleMs > 0 &&
      heartbeat &&
      !heartbeatFresh(heartbeat, heartbeatTracker, config.heartbeatStaleMs, monotonicNow)
    ) {
      // Fencing must not wait on write-back to a dead network mount. Closing
      // the VM is the single-writer safety action; periodic sync may have
      // captured earlier file edits, but availability cannot outrank fencing.
      void shutdown(0, { syncBeforeClose: false, fence: true });
    }
  }, pollIntervalMs);

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGUSR2", () => void shutdown(0, { syncBeforeClose: false, fence: true }));

  announce(
    JSON.stringify({
      ready: true,
      sessionId: vm.id,
      socketPath: session.socketPath,
      workerPid: process.pid,
      runnerPid: vm.getHostPid(),
    } satisfies GondolinWorkerHandshake),
  );
}

/** Copy file mounts into the guest; credentials get user-only permissions. */
async function projectFiles(
  vm: {
    fs: {
      mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
      writeFile: (path: string, data: Buffer) => Promise<void>;
    };
    exec: (command: string) => PromiseLike<unknown>;
  },
  files: FileProjection[],
): Promise<void> {
  for (const projection of files) {
    const content = readFileSync(projection.source);
    await vm.fs.mkdir(dirname(projection.target), { recursive: true });
    await vm.fs.writeFile(projection.target, content);
    if (!projection.syncBack) {
      // credential projection: no write-back, keep it owner-only
      await vm.exec(`chmod 600 ${shellEscape(projection.target)}`);
    }
    projection.lastHash = sha256(content);
  }
}
