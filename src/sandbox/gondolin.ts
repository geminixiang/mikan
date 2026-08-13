import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as log from "../log.js";
import type { ResourceLimits, SandboxLimitStatus, SandboxResourceController } from "../types.js";
import { withRuntimeBootstrap } from "./container.js";
import { SandboxError } from "./errors.js";
import { createMountedRuntimePathContext } from "@geminixiang/mikan-sandbox-contract";
import { execReadFile, execReadFileBase64, execWriteFile, shellEscape } from "./utils.js";
import type * as GondolinNamespace from "@earendil-works/gondolin";
import type {
  ExecOptions,
  ExecResult,
  Executor,
  GondolinBootstrapOptions,
  GondolinSandboxConfig,
  RuntimePathContext,
  SandboxAdapter,
  SessionClient,
  SessionClientCallbacks,
} from "./types.js";

export type { SessionClient, SessionClientCallbacks } from "./types.js";

/**
 * Single-host Gondolin sandbox: one microVM per conversation, created and
 * owned by this mikan process.
 *
 * Commands do not go through `vm.exec()` — aborting that only rejects the
 * local promise and leaves the guest process running. They go over Gondolin's
 * session IPC socket instead, one connection per command, so an abort or
 * timeout closes the connection and kills the command inside the guest.
 *
 * Runtimes die with mikan: Gondolin SIGKILLs its VM runners from a
 * `process.exit` hook, and shutdown closes them explicitly so projected files
 * sync back first. A `kill -9` of mikan itself skips both and leaks a runner.
 */

type GondolinModule = typeof GondolinNamespace;
type GondolinVm = InstanceType<GondolinModule["VM"]>;

const MINIMUM_NODE_VERSION = [23, 6, 0] as const;
const MIKAN_IMAGE = "mikan-sandbox:latest";

/** Write-back cadence for projected `/workspace` files (e.g. MEMORY.md). */
const PROJECTION_SYNC_INTERVAL_MS = 2000;
const PROJECTION_LOCK_RETRY_MS = 25;
const PROJECTION_LOCK_STALE_MS = 60_000;

/**
 * A command may quietly work for a long time, but a session that produces no
 * frame at all for this long is indistinguishable from one wedged on dead
 * storage (for example, blocked guest workspace I/O) — kill it and say so
 * instead of hanging the run.
 */
const EXEC_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const sessions = new Map<string, GondolinSession>();
const transitions = new Map<string, Promise<void>>();
let activeShutdowns = 0;
let shutdownGeneration = 0;

interface GondolinSession {
  runtime: Promise<GondolinRuntime>;
  fingerprint: string;
  resourceKey?: string;
  activeOperations: number;
  lastUsed: number;
  idleWaiters: Array<() => void>;
}

/** A host directory or file offered to the guest. */
interface GondolinMount {
  source: string;
  target: string;
  /** Mounted through `ReadonlyProvider`; host-owned content the agent must not edit. */
  readOnly?: boolean;
}

interface GondolinDesiredRuntime {
  image: string;
  imageIdentity: string;
  mounts: GondolinMount[];
  /** Content identity of projected credential files (rotation → drift). */
  credentialIdentity: Record<string, string>;
  limits?: ResourceLimits;
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
  /** Hash of the guest content at the last successful or conflict sync. */
  lastHash: string;
}

/*
 * Crash-recovery vocabulary.
 *
 * - **Gone**: the command never reached the runtime because its session socket
 *   refused the connection. Recreating the runtime and retrying is safe.
 * - **Interrupted**: the runtime died or went silent with a command in flight.
 *   Side effects may have landed, so the failure must surface.
 */

/**
 * The runtime is gone and the command never reached it (the session socket
 * refused the connection) — safe to recreate the runtime and retry.
 */
class GondolinRuntimeGoneError extends Error {}

/** The runtime died with the command in flight — not safe to retry blindly. */
class GondolinRuntimeInterruptedError extends Error {}

class GondolinResourceManager implements SandboxResourceController {
  private defaultLimits?: ResourceLimits;
  private boostLimits?: ResourceLimits;
  private readonly boostedKeys = new Set<string>();
  private readonly overrideLimits = new Map<string, ResourceLimits>();

  configure(defaultLimits?: ResourceLimits, boostLimits?: ResourceLimits): void {
    this.defaultLimits = defaultLimits;
    this.boostLimits = boostLimits;
    this.boostedKeys.clear();
    this.overrideLimits.clear();
  }

  async boost(key: string): Promise<SandboxLimitStatus> {
    if (this.boostLimits?.cpus || this.boostLimits?.memory) {
      this.overrideLimits.delete(key);
      this.boostedKeys.add(key);
    }
    return this.getLimitStatus(key);
  }

  async setLimits(key: string, limits: ResourceLimits): Promise<SandboxLimitStatus> {
    this.boostedKeys.delete(key);
    this.overrideLimits.set(key, { ...this.defaultLimits, ...limits });
    return this.getLimitStatus(key);
  }

  getLimitStatus(key: string): SandboxLimitStatus {
    return { limits: this.effectiveLimits(key), boosted: this.boostedKeys.has(key) };
  }

  getDefaultLimits(): ResourceLimits | undefined {
    return this.defaultLimits;
  }

  getBoostLimits(): ResourceLimits | undefined {
    return this.boostLimits;
  }

  clear(key: string): void {
    this.boostedKeys.delete(key);
    this.overrideLimits.delete(key);
  }

  private effectiveLimits(key: string): ResourceLimits | undefined {
    const override = this.overrideLimits.get(key);
    if (override) return override;
    if (!this.boostedKeys.has(key)) return this.defaultLimits;
    return { ...this.defaultLimits, ...this.boostLimits };
  }
}

export const gondolinResources = new GondolinResourceManager();

/** Configure the Gondolin resource controller. */
export function configureGondolinRuntime(options: GondolinBootstrapOptions): void {
  gondolinResources.configure(options.limits, options.boostLimits);
}

function parseGondolinSandboxArg(value: string): GondolinSandboxConfig | undefined {
  if (!value.startsWith("gondolin:")) return undefined;

  const profile = value.slice("gondolin:".length);
  if (!profile) {
    throw new SandboxError("Error: gondolin sandbox requires a profile (e.g., gondolin:default)");
  }
  if (profile !== "default") {
    throw new SandboxError(
      `Error: unsupported gondolin profile '${profile}'. Use 'gondolin:default'`,
    );
  }
  return { type: "gondolin", profile };
}

function assertSupportedNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < MINIMUM_NODE_VERSION[0] || (major === MINIMUM_NODE_VERSION[0] && minor < 6)) {
    throw new SandboxError(
      `Error: gondolin:default requires Node.js >=23.6.0 (current: ${process.versions.node}). Other sandbox modes remain available on Node.js >=22.19.0.`,
    );
  }
}

async function validateGondolinSandbox(): Promise<void> {
  assertSupportedNodeVersion();
  console.log("  Gondolin microVM enabled. Profile: default");
}

async function resolveDesiredRuntime(
  config: GondolinSandboxConfig,
): Promise<GondolinDesiredRuntime> {
  const selector = config.image ?? MIKAN_IMAGE;
  const { ensureImageSelector } = (await import("@earendil-works/gondolin")) as GondolinModule;
  const resolvedImage = await ensureImageSelector(selector);
  const image = resolvedImage.assetDir;
  const imageIdentity = resolvedImage.buildId ?? resolvedImage.assetDir;
  const mounts = (
    config.mounts ?? [{ source: config.workspacePath ?? process.cwd(), target: "/workspace" }]
  ).toSorted((left, right) => left.target.localeCompare(right.target));
  return {
    image,
    imageIdentity,
    mounts,
    credentialIdentity: credentialIdentity(mounts),
    limits: config.resourceKey
      ? gondolinResources.getLimitStatus(config.resourceKey).limits
      : undefined,
  };
}

/**
 * Content hashes of credential file mounts (files projected outside
 * /workspace). Rotating a credential on the host changes the fingerprint, so
 * the next command recreates the runtime with a fresh projection instead of
 * serving the stale copy for the rest of the VM's life. Workspace files are
 * excluded: the guest writes them back, which would drift the runtime it runs
 * in.
 */
function credentialIdentity(mounts: GondolinMount[]): Record<string, string> {
  const identity: Record<string, string> = {};
  for (const mount of mounts) {
    if (mount.target.startsWith("/workspace/") || mount.target === "/workspace") continue;
    try {
      if (!statSync(mount.source).isFile()) continue;
      identity[mount.target] = createHash("sha256")
        .update(readFileSync(mount.source))
        .digest("hex");
    } catch {
      // missing source: creation skips it too, so it has no runtime identity
    }
  }
  return identity;
}

function runtimeFingerprint(desired: GondolinDesiredRuntime): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        image: desired.imageIdentity,
        mounts: desired.mounts,
        credentials: desired.credentialIdentity,
        limits: desired.limits,
      }),
    )
    .digest("hex");
}

function gondolinCpuCount(cpus: string | undefined): number | undefined {
  if (cpus === undefined) return undefined;
  const parsed = Number(cpus);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new SandboxError(`Error: invalid Gondolin CPU limit '${cpus}'`);
  }
  // ponytail: Gondolin exposes whole vCPUs; add host cgroup quotas if fractional enforcement matters.
  return Math.ceil(parsed);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function partitionMounts(mounts: GondolinMount[]): {
  directories: GondolinMount[];
  files: FileProjection[];
} {
  const directories: GondolinMount[] = [];
  const files: FileProjection[] = [];
  for (const mount of mounts) {
    let isDirectory: boolean;
    try {
      isDirectory = statSync(mount.source).isDirectory();
    } catch {
      log.logWarning(`Skipping missing Gondolin mount source ${mount.source}`);
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

/** Copy file mounts into the guest; credentials get user-only permissions. */
async function projectFiles(vm: GondolinVm, files: FileProjection[]): Promise<void> {
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

function projectionLockIsStale(lockPath: string): boolean {
  let ownerKnown = false;
  let ownerAlive = false;
  try {
    const pid = Number(readFileSync(join(lockPath, "owner"), "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      ownerKnown = true;
      try {
        process.kill(pid, 0);
        ownerAlive = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM") ownerAlive = true;
      }
    }
  } catch {
    // An owner file may not have been written before its process died.
  }
  try {
    const oldEnough = Date.now() - statSync(lockPath).mtimeMs >= PROJECTION_LOCK_STALE_MS;
    return (ownerKnown && !ownerAlive) || oldEnough;
  } catch {
    return false;
  }
}

async function withProjectionLock<T>(source: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${source}.mikan-sync.lock`;
  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(join(lockPath, "owner"), `${process.pid}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (projectionLockIsStale(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, PROJECTION_LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** One live microVM owned by this process, addressed by its session socket. */
class GondolinRuntime {
  private syncTimer?: NodeJS.Timeout;
  private syncing = false;
  private closing?: Promise<void>;

  private constructor(
    private readonly vm: GondolinVm,
    private readonly socketPath: string,
    private readonly projections: FileProjection[],
  ) {}

  /** Boot a VM for the desired configuration and make it command-ready. */
  static async create(
    instanceId: string,
    desired: GondolinDesiredRuntime,
  ): Promise<GondolinRuntime> {
    const { VM, RealFSProvider, ReadonlyProvider, findSession } =
      (await import("@earendil-works/gondolin")) as GondolinModule;
    const { directories, files } = partitionMounts(desired.mounts);
    const vm = await VM.create({
      sandbox: { imagePath: desired.image },
      env: { TZ: "Asia/Taipei" },
      sessionLabel: `mikan:${instanceId}`,
      cpus: gondolinCpuCount(desired.limits?.cpus),
      memory: desired.limits?.memory,
      vfs: {
        mounts: Object.fromEntries(
          directories.map(({ source, target, readOnly }) => [
            target,
            // ReadonlyProvider blocks every write operation on the backing
            // provider — gondolin's own answer to read-only host directories.
            readOnly
              ? new ReadonlyProvider(new RealFSProvider(source))
              : new RealFSProvider(source),
          ]),
        ),
      },
    });

    try {
      await vm.start();
      await projectFiles(vm, files);
      const session = await findSession(vm.id);
      if (!session) throw new Error(`Gondolin session '${vm.id}' did not register`);
      restrictSocketAccess(session.socketPath);
      const runtime = new GondolinRuntime(vm, session.socketPath, files);
      runtime.startProjectionSync();
      return runtime;
    } catch (error) {
      // never leave a half-booted runner (and its overlay disk) behind
      await vm.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Run one command over a dedicated session IPC connection. Aborting (or the
   * caller's timeout signal firing) destroys the connection, which kills the
   * in-flight guest process.
   */
  async exec(
    command: string,
    options: { env?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<ExecResult> {
    return execOverSessionConnect(
      async (callbacks) => {
        const { connectToSession } = await import("@earendil-works/gondolin");
        return connectToSession(this.socketPath, callbacks);
      },
      command,
      options,
    );
  }

  /** Whether the VM runner process is still up. */
  isAlive(): boolean {
    try {
      return this.vm.getHostPid() !== null;
    } catch {
      return false;
    }
  }

  /** Sync projected files back one last time, then shut the VM down. */
  async close(): Promise<void> {
    this.closing ??= (async () => {
      clearInterval(this.syncTimer);
      try {
        await this.syncProjections();
      } catch {
        // best effort; the periodic sync already captured earlier edits
      }
      await this.vm.close();
    })();
    return this.closing;
  }

  private startProjectionSync(): void {
    if (!this.projections.some((projection) => projection.syncBack)) return;
    this.syncTimer = setInterval(() => void this.syncProjections(), PROJECTION_SYNC_INTERVAL_MS);
    this.syncTimer.unref?.();
  }

  private async syncProjections(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      for (const projection of this.projections) {
        if (!projection.syncBack) continue;
        try {
          const data = await this.vm.fs.readFile(projection.target);
          const content = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
          const hash = sha256(content);
          if (hash === projection.lastHash) continue;
          await withProjectionLock(projection.source, async () => {
            let hostHash: string;
            try {
              hostHash = sha256(readFileSync(projection.source));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              hostHash = "";
            }
            if (hostHash !== projection.lastHash) {
              const conflict = `${projection.source}.mikan-conflict.${process.pid}.${randomBytes(8).toString("hex")}`;
              writeFileSync(conflict, content);
              projection.lastHash = hash;
              log.logWarning(
                `Skipped Gondolin projection write-back for '${projection.source}': host content changed; guest content preserved at '${conflict}'`,
              );
              return;
            }
            // atomic host write: a crash mid-sync must not truncate the file
            const staged = `${projection.source}.mikan-sync.${process.pid}.${randomBytes(8).toString("hex")}`;
            try {
              writeFileSync(staged, content);
              renameSync(staged, projection.source);
              projection.lastHash = hash;
            } finally {
              try {
                unlinkSync(staged);
              } catch {
                // rename succeeded or the staging write failed
              }
            }
          });
        } catch {
          // guest file missing or read raced a writer; next tick retries
        }
      }
    } finally {
      this.syncing = false;
    }
  }
}

function abortError(): Error {
  return new Error("Error: command aborted");
}

/**
 * Run one command through a fresh session connection. Closing the connection
 * (abort, timeout, or the far side dying) kills the in-flight guest process.
 */
export async function execOverSessionConnect(
  connect: (callbacks: SessionClientCallbacks) => SessionClient | Promise<SessionClient>,
  command: string,
  options: { env?: Record<string, string>; signal?: AbortSignal; idleTimeoutMs?: number } = {},
): Promise<ExecResult> {
  if (options.signal?.aborted) throw abortError();
  const idleTimeoutMs = options.idleTimeoutMs ?? EXEC_IDLE_TIMEOUT_MS;
  return await new Promise<ExecResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let received = false;
    let settled = false;
    let client: SessionClient | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = (): void =>
      settle(() => {
        client?.close();
        reject(abortError());
      });
    const onIdle = (): void =>
      settle(() => {
        client?.close();
        reject(
          new GondolinRuntimeInterruptedError(
            `no session activity for ${Math.round(idleTimeoutMs / 1000)}s — killed the command ` +
              `(guest I/O hangs when the workspace sits on a dead mount; check the workspace health)`,
          ),
        );
      });
    const armIdleTimer = (): void => {
      if (idleTimeoutMs <= 0 || settled) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, idleTimeoutMs);
      idleTimer.unref?.();
    };
    armIdleTimer();
    const callbacks: SessionClientCallbacks = {
      onJson: (message) => {
        received = true;
        armIdleTimer();
        if (message.type === "exec_response" && message.id === 1) {
          settle(() => {
            client?.close();
            resolve({
              stdout,
              stderr,
              code: typeof message.exit_code === "number" ? message.exit_code : 1,
            });
          });
        } else if (message.type === "error") {
          settle(() => {
            client?.close();
            reject(new Error(`Error: Gondolin exec failed (${message.code}): ${message.message}`));
          });
        }
      },
      onBinary: (frame) => {
        received = true;
        armIdleTimer();
        const tag = frame.readUInt8(0);
        const data = frame.subarray(5).toString("utf8");
        if (tag === 1) stdout += data;
        else stderr += data;
      },
      onClose: (error) => {
        settle(() => {
          const detail = error?.message ?? "connection closed before the command finished";
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          if (!received && (code === "ENOENT" || code === "ECONNREFUSED")) {
            reject(new GondolinRuntimeGoneError(detail));
          } else {
            reject(new GondolinRuntimeInterruptedError(detail));
          }
        });
      },
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(connect(callbacks))
      .then((created) => {
        client = created;
        if (settled) {
          created.close();
          return;
        }
        created.send({
          type: "exec",
          id: 1,
          cmd: "/bin/sh",
          argv: ["-c", command],
          env: Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`),
          cwd: "/workspace",
        });
      })
      .catch((err: unknown) =>
        settle(() =>
          reject(new GondolinRuntimeGoneError(err instanceof Error ? err.message : String(err))),
        ),
      );
  });
}

function createSession(
  key: string,
  config: GondolinSandboxConfig,
  desired: GondolinDesiredRuntime,
  fingerprint: string,
): GondolinSession {
  let session: GondolinSession;
  const runtime = GondolinRuntime.create(key, desired).catch((error: unknown) => {
    if (sessions.get(key) === session) sessions.delete(key);
    throw error;
  });
  session = {
    runtime,
    fingerprint,
    resourceKey: config.resourceKey,
    activeOperations: 0,
    lastUsed: Date.now(),
    idleWaiters: [],
  };
  return session;
}

async function acquireSession(
  key: string,
  config: GondolinSandboxConfig,
  generation = shutdownGeneration,
): Promise<GondolinSession> {
  if (activeShutdowns > 0 || generation !== shutdownGeneration) {
    throw new SandboxError("Error: Gondolin runtime is shutting down");
  }

  const pending = transitions.get(key);
  if (pending) {
    await pending;
    return acquireSession(key, config, generation);
  }

  const desired = await resolveDesiredRuntime(config);
  if (activeShutdowns > 0 || generation !== shutdownGeneration) {
    throw new SandboxError("Error: Gondolin runtime is shutting down");
  }
  const concurrentTransition = transitions.get(key);
  if (concurrentTransition) {
    await concurrentTransition;
    return acquireSession(key, config, generation);
  }

  const fingerprint = runtimeFingerprint(desired);
  const existing = sessions.get(key);
  if (existing?.fingerprint === fingerprint) {
    existing.activeOperations += 1;
    return existing;
  }

  const transition = replaceSession(key, config, desired, fingerprint, existing);
  transitions.set(key, transition);
  try {
    await transition;
  } finally {
    if (transitions.get(key) === transition) transitions.delete(key);
  }
  return acquireSession(key, config, generation);
}

async function replaceSession(
  key: string,
  config: GondolinSandboxConfig,
  desired: GondolinDesiredRuntime,
  fingerprint: string,
  existing: GondolinSession | undefined,
): Promise<void> {
  if (existing) {
    await closeSession(key, existing, {
      waitForActiveOperations: true,
      resetResources: false,
      throwOnError: true,
    });
  }
  const replacement = createSession(key, config, desired, fingerprint);
  sessions.set(key, replacement);
  await replacement.runtime;
}

function discardDeadSession(key: string, session: GondolinSession): void {
  if (sessions.get(key) !== session) return;
  sessions.delete(key);
  log.logWarning(`Gondolin runtime for '${key}' died; the session will be recreated`);
}

async function withRuntime<T>(
  key: string,
  config: GondolinSandboxConfig,
  operation: (runtime: GondolinRuntime) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const session = await acquireSession(key, config);
    let runtime: GondolinRuntime | undefined;
    try {
      runtime = await session.runtime;
      return await operation(runtime);
    } catch (error) {
      const gone = error instanceof GondolinRuntimeGoneError;
      const interrupted = error instanceof GondolinRuntimeInterruptedError;
      if (gone || (interrupted && runtime && !runtime.isAlive())) {
        discardDeadSession(key, session);
      }
      // Nothing reached a gone runtime, so recreating and retrying is safe;
      // an interrupted command may have side effects and must surface.
      if (gone && attempt === 0) continue;
      if (gone || interrupted) {
        throw new SandboxError(
          `Error: Gondolin runtime for '${key}' died (${(error as Error).message}); it is recreated on the next command`,
        );
      }
      throw error;
    } finally {
      session.activeOperations -= 1;
      session.lastUsed = Date.now();
      if (session.activeOperations === 0) {
        for (const resolve of session.idleWaiters.splice(0)) resolve();
      }
    }
  }
}

function waitForIdle(session: GondolinSession): Promise<void> {
  if (session.activeOperations === 0) return Promise.resolve();
  return new Promise((resolve) => session.idleWaiters.push(resolve));
}

async function closeSession(
  key: string,
  session: GondolinSession,
  options: {
    waitForActiveOperations?: boolean;
    resetResources?: boolean;
    throwOnError?: boolean;
  } = {},
): Promise<void> {
  if (sessions.get(key) !== session) return;
  sessions.delete(key);
  try {
    if (options.waitForActiveOperations) await waitForIdle(session);
    const runtime = await session.runtime;
    await runtime.close();
    if (
      options.resetResources !== false &&
      session.resourceKey &&
      !Array.from(sessions.values()).some(({ resourceKey }) => resourceKey === session.resourceKey)
    ) {
      gondolinResources.clear(session.resourceKey);
    }
  } catch (error) {
    session.fingerprint = "";
    // Re-track for a retried close, unless a replacement already claimed the
    // key — then the failed runtime stays for the reconcile paths and
    // clobbering the replacement would leak it too.
    if (!sessions.has(key)) sessions.set(key, session);
    if (options.throwOnError) throw error;
    log.logWarning(
      `Failed to close Gondolin session '${key}'`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function stopIdleGondolinVms(maxIdleMs: number, now = Date.now()): Promise<void> {
  const idle = Array.from(sessions.entries()).filter(
    ([key, session]) =>
      !transitions.has(key) &&
      session.activeOperations === 0 &&
      now - session.lastUsed >= maxIdleMs,
  );
  await Promise.all(
    idle.map(([key, session]) => {
      // Register the close as a transition so a concurrent acquire waits for
      // it instead of racing the shared session slot.
      const transition = closeSession(key, session).finally(() => {
        if (transitions.get(key) === transition) transitions.delete(key);
      });
      transitions.set(key, transition);
      return transition;
    }),
  );
}

/**
 * Drop Gondolin's registry entries for sessions that no longer answer — socket
 * files and metadata left behind by a mikan that died without cleanup.
 */
async function reconcileGondolinRuntimes(): Promise<void> {
  try {
    const { gcSessions } = (await import("@earendil-works/gondolin")) as GondolinModule;
    const collected = await gcSessions();
    log.logInfo(`Reconciled Gondolin sessions (collected=${collected})`);
  } catch (error) {
    log.logWarning(
      "Failed to collect Gondolin session registry",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Stop every runtime this process owns. Runtimes do not outlive mikan, so
 * shutdown must close them: that syncs projected files back to the host and
 * releases each VM's overlay disk before the process exits.
 */
export async function stopAllGondolinRuntimes(): Promise<void> {
  shutdownGeneration += 1;
  activeShutdowns += 1;
  try {
    await Promise.allSettled(transitions.values());
    const current = Array.from(sessions.entries());
    await Promise.all(
      current.map(([key, session]) =>
        closeSession(key, session, { waitForActiveOperations: true }),
      ),
    );
  } finally {
    activeShutdowns -= 1;
  }
}

function executionSignal(options?: ExecOptions): AbortSignal | undefined {
  const signals = [options?.signal];
  if (options?.timeout && options.timeout > 0) {
    signals.push(AbortSignal.timeout(options.timeout * 1000));
  }
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return active.length > 0 ? AbortSignal.any(active) : undefined;
}

export class GondolinExecutor implements Executor {
  private readonly workspacePath: string;
  private readonly instanceId: string;

  constructor(
    private readonly config: GondolinSandboxConfig,
    private readonly env?: Record<string, string>,
  ) {
    assertSupportedNodeVersion();
    this.workspacePath = config.workspacePath ?? process.cwd();
    this.instanceId = config.instanceId ?? this.workspacePath;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return withRuntime(this.instanceId, this.config, (runtime) =>
      runtime.exec(withRuntimeBootstrap(command, this.env), {
        env: this.env,
        signal: executionSignal(options),
      }),
    );
  }

  async readFile(path: string): Promise<string> {
    return execReadFile(this, path);
  }

  async readFileBase64(path: string): Promise<string> {
    return execReadFileBase64(this, path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    return execWriteFile(this, path, content);
  }

  getWorkspacePath(): string {
    return "/workspace";
  }

  getPathContext(hostWorkspaceRoot: string): RuntimePathContext {
    return createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace");
  }

  getSandboxConfig(): GondolinSandboxConfig {
    return this.config;
  }
}

export const gondolinSandboxAdapter: SandboxAdapter<GondolinSandboxConfig> = {
  type: "gondolin",
  credentials: { env: true, fileMounts: true },
  workspace: { managedProjection: true },
  vault: { routingLabel: "conversation", ambientSharedVault: false },
  parse: parseGondolinSandboxArg,
  validate: validateGondolinSandbox,
  createExecutor: (config, env) => new GondolinExecutor(config, env),
  resolveRuntimeConfig: (config, { workspaceRoot, mounts, resourceKey }) => ({
    ...config,
    workspacePath: workspaceRoot,
    mounts,
    instanceId: resourceKey,
    resourceKey,
  }),
  createResourceController: () => gondolinResources,
  prepareBoot: ({ limits, boostLimits }) =>
    configureGondolinRuntime({
      limits,
      boostLimits,
    }),
  startIdleManagement: async ({ idleTimeoutMs }) => {
    await reconcileGondolinRuntimes();
    const idleMs = idleTimeoutMs ?? DEFAULT_GONDOLIN_IDLE_TIMEOUT_MS;
    setInterval(() => void stopIdleGondolinVms(idleMs), idleMs).unref();
  },
  shutdown: () => stopAllGondolinRuntimes(),
  describe: (config) => `gondolin:${config.profile}`,
};

const DEFAULT_GONDOLIN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
