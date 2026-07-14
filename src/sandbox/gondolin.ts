import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as log from "../log.js";
import type { ResourceLimits, SandboxLimitStatus, SandboxResourceController } from "../types.js";
import { SandboxError } from "./errors.js";
import { gondolinInventory } from "./gondolin-inventory.js";
import {
  GondolinRuntimeGoneError,
  GondolinRuntimeInterruptedError,
  gondolinWorkers,
  type GondolinRuntimeHandle,
  type GondolinRuntimeTransport,
} from "./gondolin-worker-client.js";
import { gondolinFleet } from "./gondolin-fleet.js";
import { createMountedRuntimePathContext } from "./path-context.js";
import { withRuntimeBootstrap } from "./container.js";
import { execReadFile, execWriteFile } from "./utils.js";
import type {
  ExecOptions,
  ExecResult,
  Executor,
  GondolinSandboxConfig,
  RuntimePathContext,
  SandboxAdapter,
} from "./types.js";

type GondolinModule = typeof import("@earendil-works/gondolin");

interface GondolinSession {
  runtime: Promise<GondolinRuntimeHandle>;
  transport: GondolinRuntimeTransport;
  fingerprint: string;
  resourceKey?: string;
  activeOperations: number;
  lastUsed: number;
  idleWaiters: Array<() => void>;
}

interface GondolinDesiredRuntime {
  image: string;
  imageIdentity: string;
  mounts: Array<{ source: string; target: string }>;
  /** Content identity of projected credential files (rotation → drift). */
  credentialIdentity: Record<string, string>;
  limits?: ResourceLimits;
}

const MINIMUM_NODE_VERSION = [23, 6, 0] as const;
const MIKAN_IMAGE = "mikan-sandbox:latest";
const sessions = new Map<string, GondolinSession>();
const transitions = new Map<string, Promise<void>>();
let activeShutdowns = 0;
let shutdownGeneration = 0;

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

function parseGondolinSandboxArg(value: string): GondolinSandboxConfig | undefined {
  if (!value.startsWith("gondolin:")) return undefined;

  const profile = value.slice("gondolin:".length);
  if (!profile) {
    throw new SandboxError("Error: gondolin sandbox requires a profile (e.g., gondolin:default)");
  }
  if (profile !== "default" && profile !== "remote") {
    throw new SandboxError(
      `Error: unsupported gondolin profile '${profile}'. Use 'gondolin:default' or 'gondolin:remote'`,
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

async function validateGondolinSandbox(config?: GondolinSandboxConfig): Promise<void> {
  if (config?.profile === "remote") {
    if (!gondolinFleet.isConfigured()) {
      throw new SandboxError(
        "Error: gondolin:remote requires sandbox.gondolin.remote settings (url, certFile, keyFile)",
      );
    }
    console.log("  Gondolin microVM enabled. Profile: remote");
    return;
  }
  assertSupportedNodeVersion();
  console.log("  Gondolin microVM enabled. Profile: default");
}

function transportFor(config: GondolinSandboxConfig): GondolinRuntimeTransport {
  return config.profile === "remote" ? gondolinFleet : gondolinWorkers;
}

async function resolveDesiredRuntime(
  config: GondolinSandboxConfig,
): Promise<GondolinDesiredRuntime> {
  let image: string;
  let imageIdentity: string;
  if (config.profile === "remote") {
    // image assets live on the worker host; the selector is the identity
    image = gondolinFleet.imageSelector() ?? config.image ?? MIKAN_IMAGE;
    imageIdentity = image;
  } else {
    const selector = config.image ?? MIKAN_IMAGE;
    const { ensureImageSelector } = (await import("@earendil-works/gondolin")) as GondolinModule;
    const resolvedImage = await ensureImageSelector(selector);
    image = resolvedImage.assetDir;
    imageIdentity = resolvedImage.buildId ?? resolvedImage.assetDir;
  }
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
function credentialIdentity(
  mounts: Array<{ source: string; target: string }>,
): Record<string, string> {
  const identity: Record<string, string> = {};
  for (const mount of mounts) {
    if (mount.target.startsWith("/workspace/") || mount.target === "/workspace") continue;
    try {
      if (!statSync(mount.source).isFile()) continue;
      identity[mount.target] = createHash("sha256")
        .update(readFileSync(mount.source))
        .digest("hex");
    } catch {
      // missing source: the worker skips it too, so it has no runtime identity
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

function createSession(
  key: string,
  config: GondolinSandboxConfig,
  desired: GondolinDesiredRuntime,
  fingerprint: string,
): GondolinSession {
  const transport = transportFor(config);
  let session: GondolinSession;
  const runtime = transport
    .ensure(key, {
      image: desired.image,
      mounts: desired.mounts,
      cpus: desired.limits?.cpus,
      vmCpus: gondolinCpuCount(desired.limits?.cpus),
      memory: desired.limits?.memory,
      fingerprint,
      workspacePath: config.workspacePath,
    })
    .catch((error) => {
      if (sessions.get(key) === session) sessions.delete(key);
      throw error;
    });
  session = {
    runtime,
    transport,
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
  operation: (handle: GondolinRuntimeHandle) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const session = await acquireSession(key, config);
    let handle: GondolinRuntimeHandle | undefined;
    try {
      handle = await session.runtime;
      return await operation(handle);
    } catch (error) {
      const gone = error instanceof GondolinRuntimeGoneError;
      const interrupted = error instanceof GondolinRuntimeInterruptedError;
      if (gone || (interrupted && handle && !(await session.transport.isRuntimeAlive(handle)))) {
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
    stopRuntime?: boolean;
  } = {},
): Promise<void> {
  if (sessions.get(key) !== session) return;
  sessions.delete(key);
  try {
    if (options.waitForActiveOperations) await waitForIdle(session);
    const handle = await session.runtime;
    if (options.stopRuntime !== false) await session.transport.stop(handle);
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
 * Stop workers surviving from a previous mikan that no conversation has
 * adopted — without this, a runtime whose conversation went quiet before the
 * restart would idle forever (its worker only self-stops when every mikan is
 * gone, and the in-memory idle sweep only tracks acquired sessions).
 */
export async function sweepUnadoptedGondolinWorkers(): Promise<void> {
  for (const record of gondolinInventory.listWorkerRecords()) {
    if (sessions.has(record.instanceId) || transitions.has(record.instanceId)) continue;
    log.logInfo(
      `Stopping unadopted Gondolin worker ${record.ownerPid} (instance '${record.instanceId}')`,
    );
    await gondolinWorkers.stop({ workerPid: record.ownerPid, sessionId: record.sessionId });
  }
}

/**
 * Forget every session without stopping the workers: runtimes deliberately
 * outlive the mikan process so the next one adopts them instead of paying a
 * VM boot per conversation on every deploy.
 */
export async function disconnectAllGondolinRuntimes(): Promise<void> {
  shutdownGeneration += 1;
  activeShutdowns += 1;
  try {
    await Promise.allSettled(transitions.values());
    const current = Array.from(sessions.entries());
    await Promise.all(
      current.map(([key, session]) =>
        closeSession(key, session, { waitForActiveOperations: true, stopRuntime: false }),
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
    // remote runtimes never load gondolin in this process, so the mikan host
    // may stay on the supported Node floor
    if (config.profile !== "remote") assertSupportedNodeVersion();
    this.workspacePath = config.workspacePath ?? process.cwd();
    this.instanceId = config.instanceId ?? this.workspacePath;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return withRuntime(this.instanceId, this.config, (handle) =>
      transportFor(this.config).exec(handle, withRuntimeBootstrap(command, this.env), {
        env: this.env,
        signal: executionSignal(options),
      }),
    );
  }

  async readFile(path: string): Promise<string> {
    return execReadFile(this, path);
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
  parse: parseGondolinSandboxArg,
  validate: validateGondolinSandbox,
  createExecutor: (config, env) => new GondolinExecutor(config, env),
};
