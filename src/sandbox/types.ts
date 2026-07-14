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
  workspacePath?: string;
  instanceId?: string;
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

export interface SandboxAdapter<TConfig extends SandboxConfig = SandboxConfig> {
  type: TConfig["type"];
  parse(value: string): TConfig | undefined;
  validate?(config: TConfig): Promise<void>;
  createExecutor?(
    config: TConfig,
    env?: Record<string, string>,
    ensureReady?: () => Promise<void>,
  ): Executor;
}
