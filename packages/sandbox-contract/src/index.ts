/**
 * @geminixiang/mikan-sandbox-contract — the sandbox backend plugin contract.
 *
 * Single home for the surface a sandbox plugin implements and the daemon
 * core composes against: `SandboxAdapter` (open over `{ type: string }`
 * configs), the `Executor` interface, capabilities, boot/resolution
 * contexts, and the small path/process helpers sandbox backends share.
 *
 * The daemon's `src/sandbox/types.ts` re-exports these types (with the
 * built-in `SandboxConfig` union as the local default config), so existing
 * import sites keep working while plugins compile against this package.
 */

// ── executor ─────────────────────────────────────────────────────────────────

export interface ExecOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RuntimePathContext {
  /** Host-side workspace root used by mikan's control plane. */
  hostWorkspaceRoot: string;
  /** Workspace root as seen by bash/read/write/edit inside the runtime. */
  runtimeWorkspaceRoot: string;
  /** Translate a runtime path back to a host path when the runtime is host-backed. */
  runtimeToHostPath?: (runtimePath: string) => string;
}

export interface Executor<C extends SandboxConfigBase = SandboxConfigBase> {
  /**
   * Execute a bash command.
   */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /**
   * Read a runtime file as UTF-8 text. The executor owns the transport, so
   * file contents never pass through shell argv or extra shell parse layers.
   */
  readFile(path: string, options?: ExecOptions): Promise<string>;

  /**
   * Read a runtime file as base64 (for binary content, e.g. images). Same
   * transport ownership as readFile.
   */
  readFileBase64(path: string, options?: ExecOptions): Promise<string>;

  /**
   * Write a runtime file, creating parent directories and replacing via a
   * staging file so an aborted write never truncates the target. Like
   * readFile, transport is the executor's concern — content must survive
   * arbitrary quoting and ARG_MAX limits.
   */
  writeFile(path: string, content: string, options?: ExecOptions): Promise<void>;

  /**
   * Get the workspace path prefix for this executor.
   * Host: returns the actual path.
   * Container/Firecracker: returns /workspace.
   */
  getWorkspacePath(hostPath: string): string;

  /**
   * Return explicit host/control-plane/runtime path semantics for this executor.
   */
  getPathContext(hostWorkspaceRoot: string): RuntimePathContext;

  /**
   * Get the current sandbox config used by this executor.
   */
  getSandboxConfig(): C;
}

// ── config base ──────────────────────────────────────────────────────────────

/** The open sandbox config base: plugins declare their own `type` and shape. */
export type SandboxConfigBase = { type: string };

// ── capabilities ─────────────────────────────────────────────────────────────

export interface SandboxCredentialCapabilities {
  env: boolean;
  fileMounts: boolean;
}

export interface SandboxWorkspaceCapabilities {
  /** Whether mikan can enforce the managed conversation workspace projection. */
  managedProjection: boolean;
}

/**
 * Adapter-declared vault semantics. The core never decides these per sandbox
 * type; the backend declares how credentials route, so a plugin backend can
 * opt in without touching core logic.
 */
export interface SandboxVaultCapabilities {
  /** Startup log label for how credentials route through this backend. */
  routingLabel: "container" | "conversation" | "host";
  /**
   * Whether this backend auto-provisions per-conversation vaults that receive
   * the ambient default-shared-vault copy (isolated backends only).
   */
  ambientSharedVault: boolean;
}

// ── resource / provisioner views ─────────────────────────────────────────────

export interface ResourceLimits {
  cpus?: string;
  memory?: string;
}

export interface SandboxLimitStatus {
  limits?: ResourceLimits;
  boosted: boolean;
}

export interface SandboxResourceController {
  boost(key: string): Promise<SandboxLimitStatus>;
  setLimits(key: string, limits: ResourceLimits): Promise<SandboxLimitStatus>;
  getLimitStatus(key: string): SandboxLimitStatus;
  getDefaultLimits(): ResourceLimits | undefined;
  getBoostLimits(): ResourceLimits | undefined;
}

/** A read-only? source→target mount (structurally compatible with the daemon's ContainerMount). */
export interface SandboxMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

export interface ProvisionOptions {
  containerName?: string;
  mounts?: SandboxMount[];
  conversationId?: string;
}

/** The container provisioner view backends may need (image mode). */
export interface SandboxProvisioner {
  provision(containerKey: string, options?: ProvisionOptions): Promise<string>;
}

// ── contexts ─────────────────────────────────────────────────────────────────

/** Inputs for turning a base sandbox config into the concrete runtime config. */
export interface SandboxResolutionContext {
  resourceKey: string;
  workspaceRoot: string;
  mounts: SandboxMount[];
}

/** Inputs for building the "ensure ready before first exec" callback. */
export interface SandboxReadyContext {
  provisioner?: SandboxProvisioner;
  resourceKey: string;
  credentialKey: string;
  mounts: SandboxMount[];
  conversationId: string;
  hasVault: boolean;
}

/** Inputs for building a backend's resource controller at boot. */
export interface SandboxControllerContext {
  provisioner?: SandboxProvisioner & SandboxResourceController;
}

/** Inputs for backend boot hooks. */
export interface SandboxBootContext {
  limits?: ResourceLimits;
  boostLimits?: ResourceLimits;
  idleTimeoutMs?: number;
}

/** The resolved runtime config view: a backend may resolve into another backend's config. */
export type ResolvedSandboxConfig = SandboxConfigBase;

// ── adapter ──────────────────────────────────────────────────────────────────

/**
 * One sandbox backend. The `type` field is open: built-in backends use the
 * daemon's `SandboxConfig` union members, plugin backends declare their own
 * `type` string and config shape. The core treats configs opaquely behind
 * the adapter — it never switches on a concrete type.
 */
export interface SandboxAdapter<TConfig extends SandboxConfigBase = SandboxConfigBase> {
  type: TConfig["type"];
  credentials: SandboxCredentialCapabilities;
  workspace: SandboxWorkspaceCapabilities;
  vault: SandboxVaultCapabilities;
  parse(value: string): TConfig | undefined;
  validate?(config: TConfig): Promise<void>;
  createExecutor?(
    config: TConfig,
    env?: Record<string, string>,
    ensureReady?: () => Promise<void>,
  ): Executor<TConfig>;
  /**
   * Base image for the mikan-managed per-conversation provisioner, when this
   * backend provisions containers (image mode). Declared per config so the
   * configured image name drives the provisioner.
   */
  provisionerImage?(config: TConfig): string | undefined;
  /**
   * Turn the base config into the concrete runtime config for this actor
   * (cloudflare sandbox scoping, gondolin mounts/instance, image → container).
   * Absent: the base config is used as-is. A backend may resolve into a
   * different backend's config (image → container).
   */
  resolveRuntimeConfig?(config: TConfig, ctx: SandboxResolutionContext): ResolvedSandboxConfig;
  /**
   * Build the "ensure ready" callback run before the first exec, or undefined
   * when the backend needs no provisioning (image → provision container).
   */
  createEnsureReady?(config: TConfig, ctx: SandboxReadyContext): (() => Promise<void>) | undefined;
  /** Provide the backend's resource controller (image → provisioner, gondolin → gondolin resources). */
  createResourceController?(ctx: SandboxControllerContext): SandboxResourceController | undefined;
  /** One-time boot preparation (gondolin runtime configuration). */
  prepareBoot?(ctx: SandboxBootContext): void | Promise<void>;
  /** Boot-time idle management (gondolin runtime reconciliation + idle stop). */
  startIdleManagement?(ctx: SandboxBootContext): void | Promise<void>;
  /** Process-shutdown hook (gondolin runtime stop). */
  shutdown?(): void | Promise<void>;
  /** Startup log description of the configured sandbox. */
  describe?(config: TConfig): string;
}

// ── shared helpers ───────────────────────────────────────────────────────────

import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

/**
 * A RuntimePathContext for runtimes that mount the workspace at a fixed
 * runtime path: runtime paths under the mount translate back to host paths,
 * everything else stays as-is.
 */
export function createMountedRuntimePathContext(
  hostWorkspaceRoot: string,
  runtimeWorkspaceRoot: string,
): RuntimePathContext {
  return {
    hostWorkspaceRoot,
    runtimeWorkspaceRoot,
    runtimeToHostPath: (runtimePath) =>
      translateMountedRuntimePathToHost(runtimePath, runtimeWorkspaceRoot, hostWorkspaceRoot),
  };
}

function translateMountedRuntimePathToHost(
  runtimePath: string,
  runtimeWorkspaceRoot: string,
  hostWorkspaceRoot: string,
): string {
  if (!isAbsolute(runtimePath)) {
    return runtimePath;
  }

  const runtimeRoot = resolvePath(runtimeWorkspaceRoot);
  const normalizedRuntimePath = resolvePath(runtimePath);
  const runtimeRelativePath = relative(runtimeRoot, normalizedRuntimePath);
  const escapesRuntimeRoot =
    runtimeRelativePath === ".." ||
    runtimeRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(runtimeRelativePath);

  if (escapesRuntimeRoot) {
    return runtimePath;
  }

  const hostRoot = resolvePath(hostWorkspaceRoot);
  const hostPath = resolvePath(hostRoot, runtimeRelativePath);
  const hostRelativePath = relative(hostRoot, hostPath);
  const escapesHostRoot =
    hostRelativePath === ".." ||
    hostRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(hostRelativePath);

  return escapesHostRoot ? runtimePath : hostPath;
}

/** Kill a process and its whole descendant tree (Windows taskkill, POSIX process group). */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        detached: true,
      });
    } catch {
      // Ignore errors
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process already dead
      }
    }
  }
}
