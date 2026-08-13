import type {
  ContainerMount,
  ProvisionOptions,
  ResourceLimits,
  SandboxResourceController,
} from "../types.js";

export type SandboxConfig =
  | HostSandboxConfig
  | ContainerSandboxConfig
  | ImageSandboxConfig
  | GondolinSandboxConfig
  | FirecrackerSandboxConfig
  | CloudflareSandboxConfig;

export interface HostSandboxConfig {
  type: "host";
}

export interface ContainerSandboxConfig {
  type: "container";
  container: string;
}

export interface ImageSandboxConfig {
  type: "image";
  image: string;
}

export interface GondolinSandboxConfig {
  type: "gondolin";
  profile: "default";
  /** Local-only runtime details supplied after actor/workspace resolution. */
  image?: string;
  workspacePath?: string;
  mounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
  instanceId?: string;
  resourceKey?: string;
}

export interface GondolinBootstrapOptions {
  /** Default per-runtime resource limits. */
  limits?: ResourceLimits;
  /** Boosted limits applied while a runtime holds a boost. */
  boostLimits?: ResourceLimits;
}

export interface SessionClientCallbacks {
  onJson: (message: {
    type: string;
    id?: number;
    exit_code?: number | null;
    code?: string;
    message?: string;
  }) => void;
  onBinary: (frame: Buffer) => void;
  onClose: (error?: Error) => void;
}

export interface SessionClient {
  send(message: object): void;
  close(): void;
}

export interface FirecrackerSandboxConfig {
  type: "firecracker";
  vmId: string;
  hostPath: string;
  sshUser?: string;
  sshPort?: number;
}

export interface CloudflareSandboxConfig {
  type: "cloudflare";
  sandboxId: string;
}

export interface Executor {
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
  getSandboxConfig(): SandboxConfig;
}

export interface RuntimePathContext {
  /** Host-side workspace root used by mikan's control plane. */
  hostWorkspaceRoot: string;
  /** Workspace root as seen by bash/read/write/edit inside the runtime. */
  runtimeWorkspaceRoot: string;
  /** Translate a runtime path back to a host path when the runtime is host-backed. */
  runtimeToHostPath?: (runtimePath: string) => string;
}

export interface ExecOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SandboxCredentialCapabilities {
  env: boolean;
  fileMounts: boolean;
}

interface SandboxWorkspaceCapabilities {
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

/** The container provisioner view backends may need (image mode). */
export interface SandboxProvisioner {
  provision(containerKey: string, options?: ProvisionOptions): Promise<string>;
}

/** Inputs for turning a base sandbox config into the concrete runtime config. */
export interface SandboxResolutionContext {
  resourceKey: string;
  workspaceRoot: string;
  mounts: ContainerMount[];
}

/** Inputs for building the "ensure ready before first exec" callback. */
export interface SandboxReadyContext {
  provisioner?: SandboxProvisioner;
  resourceKey: string;
  credentialKey: string;
  mounts: ContainerMount[];
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

/**
 * One sandbox backend. The `type` field is open: built-in backends use the
 * `SandboxConfig` union members, plugin backends declare their own `type`
 * string and config shape. The core treats configs opaquely behind the
 * adapter — it never switches on a concrete type.
 */
export interface SandboxAdapter<TConfig extends { type: string } = SandboxConfig> {
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
  ): Executor;
  /**
   * Base image for the mikan-managed per-conversation provisioner, when this
   * backend provisions containers (image mode). Declared per config so the
   * configured image name drives the provisioner.
   */
  provisionerImage?(config: TConfig): string | undefined;
  /**
   * Turn the base config into the concrete runtime config for this actor
   * (cloudflare sandbox scoping, gondolin mounts/instance, image → container).
   * Absent: the base config is used as-is.
   */
  resolveRuntimeConfig?(config: TConfig, ctx: SandboxResolutionContext): SandboxConfig;
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
