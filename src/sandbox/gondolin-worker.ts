import { chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { gondolinInventory } from "./gondolin-inventory.js";

type GondolinModule = typeof import("@earendil-works/gondolin");

/**
 * Everything a worker process needs to host one Gondolin VM. Serialized as a
 * single JSON argv entry — it must stay free of secrets (vault env travels
 * per-exec over the session IPC socket, never through the worker command
 * line).
 */
export interface GondolinWorkerConfig {
  /** mikan session key the runtime belongs to. */
  instanceId: string;
  /** Resolved guest image asset directory. */
  image?: string;
  /** Image selector resolved inside the worker (remote workers, where the
   * spawning host has no image store). Ignored when `image` is set. */
  imageSelector?: string;
  mounts: Array<{ source: string; target: string }>;
  cpus?: number;
  memory?: string;
  /** Desired-runtime fingerprint recorded for adoption checks. */
  fingerprint: string;
  /** Runtime inventory directory (shared with the spawning mikan). */
  inventoryDir: string;
  /**
   * Self-stop when the mikan heartbeat file is older than this — no mikan is
   * left to adopt the runtime. 0 disables the check.
   */
  heartbeatStaleMs: number;
}

/** First stdout line of a worker, consumed by the spawning mikan. */
export interface GondolinWorkerHandshake {
  ready: boolean;
  error?: string;
  sessionId?: string;
  socketPath?: string;
  workerPid?: number;
  runnerPid?: number | null;
}

interface GondolinWorkerDeps {
  loadGondolin?: () => Promise<GondolinModule>;
  announce?: (line: string) => void;
  exit?: (code: number) => void;
  pollIntervalMs?: number;
}

function heartbeatFresh(path: string, since: number, staleMs: number): boolean {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    // no heartbeat yet — fall back to worker start time
  }
  return Date.now() - Math.max(mtimeMs, since) <= staleMs;
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
  const loadGondolin =
    deps.loadGondolin ?? (() => import("@earendil-works/gondolin") as Promise<GondolinModule>);

  gondolinInventory.configure(config.inventoryDir);
  const { VM, RealFSProvider, findSession, ensureImageSelector } = await loadGondolin();
  let imagePath = config.image;
  if (!imagePath) {
    if (!config.imageSelector) throw new Error("worker config needs image or imageSelector");
    imagePath = (await ensureImageSelector(config.imageSelector)).assetDir;
  }
  const vm = await VM.create({
    sandbox: { imagePath },
    env: { TZ: "Asia/Taipei" },
    sessionLabel: `mikan:${config.instanceId}`,
    cpus: config.cpus,
    memory: config.memory,
    vfs: {
      mounts: Object.fromEntries(
        config.mounts.map(({ source, target }) => [target, new RealFSProvider(source)]),
      ),
    },
  });
  await vm.start();
  const session = await findSession(vm.id);
  if (!session) {
    await vm.close();
    throw new Error(`Gondolin session '${vm.id}' did not register`);
  }
  restrictSocketAccess(session.socketPath);
  gondolinInventory.record({
    sessionId: vm.id,
    instanceId: config.instanceId,
    runnerPid: vm.getHostPid(),
    socketPath: session.socketPath,
    fingerprint: config.fingerprint,
  });

  const startedAt = Date.now();
  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(watchdog);
    try {
      await vm.close();
    } catch {
      // the runner may already be gone
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
    const heartbeat = gondolinInventory.heartbeatPath();
    if (
      config.heartbeatStaleMs > 0 &&
      heartbeat &&
      !heartbeatFresh(heartbeat, startedAt, config.heartbeatStaleMs)
    ) {
      void shutdown(0);
    }
  }, pollIntervalMs);

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));

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
