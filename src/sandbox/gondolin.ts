import type { VM as GondolinVM } from "@earendil-works/gondolin";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import * as log from "../log.js";
import type { ResourceLimits, SandboxLimitStatus, SandboxResourceController } from "../types.js";
import { SandboxError } from "./errors.js";
import { createMountedRuntimePathContext } from "./path-context.js";
import { withRuntimeBootstrap } from "./container.js";
import type {
  ExecOptions,
  ExecResult,
  Executor,
  GondolinSandboxConfig,
  RuntimePathContext,
  SandboxAdapter,
} from "./types.js";

type GondolinModule = typeof import("@earendil-works/gondolin");
type VM = GondolinVM;

interface GondolinSession {
  vm: Promise<VM>;
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
  const image = config.image ?? MIKAN_IMAGE;
  const { ensureImageSelector } = (await import("@earendil-works/gondolin")) as GondolinModule;
  const resolvedImage = await ensureImageSelector(image);
  return {
    image: resolvedImage.assetDir,
    imageIdentity: resolvedImage.buildId ?? resolvedImage.assetDir,
    mounts: (
      config.mounts ?? [{ source: config.workspacePath ?? process.cwd(), target: "/workspace" }]
    ).toSorted((left, right) => left.target.localeCompare(right.target)),
    limits: config.resourceKey
      ? gondolinResources.getLimitStatus(config.resourceKey).limits
      : undefined,
  };
}

function runtimeFingerprint(desired: GondolinDesiredRuntime): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        image: desired.imageIdentity,
        mounts: desired.mounts,
        limits: desired.limits,
      }),
    )
    .digest("hex");
}

async function createVM(desired: GondolinDesiredRuntime): Promise<VM> {
  const { RealFSProvider, VM } = (await import("@earendil-works/gondolin")) as GondolinModule;
  return VM.create({
    sandbox: { imagePath: desired.image },
    env: { TZ: "Asia/Taipei" },
    cpus: gondolinCpuCount(desired.limits?.cpus),
    memory: desired.limits?.memory,
    vfs: {
      mounts: Object.fromEntries(
        desired.mounts.map(({ source, target }) => [target, new RealFSProvider(source)]),
      ),
    },
  });
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
  let session: GondolinSession;
  const vm = createVM(desired).catch((error) => {
    if (sessions.get(key) === session) sessions.delete(key);
    throw error;
  });
  session = {
    vm,
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
  await replacement.vm;
}

async function withVM<T>(
  key: string,
  config: GondolinSandboxConfig,
  operation: (vm: VM) => Promise<T>,
): Promise<T> {
  const session = await acquireSession(key, config);
  try {
    return await operation(await session.vm);
  } finally {
    session.activeOperations -= 1;
    session.lastUsed = Date.now();
    if (session.activeOperations === 0) {
      for (const resolve of session.idleWaiters.splice(0)) resolve();
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
    const vm = await session.vm;
    await vm.close();
    if (
      options.resetResources !== false &&
      session.resourceKey &&
      !Array.from(sessions.values()).some(({ resourceKey }) => resourceKey === session.resourceKey)
    ) {
      gondolinResources.clear(session.resourceKey);
    }
  } catch (error) {
    session.fingerprint = "";
    sessions.set(key, session);
    if (options.throwOnError) throw error;
    log.logWarning(
      `Failed to close Gondolin session '${key}'`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function stopIdleGondolinVms(maxIdleMs: number, now = Date.now()): Promise<void> {
  const idle = Array.from(sessions.entries()).filter(
    ([, session]) => session.activeOperations === 0 && now - session.lastUsed >= maxIdleMs,
  );
  await Promise.all(idle.map(([key, session]) => closeSession(key, session)));
}

export async function closeAllGondolinVms(): Promise<void> {
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
    return withVM(this.instanceId, this.config, async (vm) => {
      const result = await vm.exec(withRuntimeBootstrap(command, this.env), {
        cwd: "/workspace",
        env: this.env,
        signal: executionSignal(options),
      });
      return { stdout: result.stdout, stderr: result.stderr, code: result.exitCode };
    });
  }

  async readFile(path: string): Promise<string> {
    return withVM(this.instanceId, this.config, (vm) => vm.fs.readFile(path, { encoding: "utf8" }));
  }

  async writeFile(path: string, content: string): Promise<void> {
    return withVM(this.instanceId, this.config, async (vm) => {
      const stage = `${path}.mikan-stage`;
      await vm.fs.mkdir(dirname(path), { recursive: true });
      await vm.fs.writeFile(stage, content);
      await vm.fs.rename(stage, path);
    });
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
