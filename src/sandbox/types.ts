export type SandboxConfig =
  | HostSandboxConfig
  | ContainerSandboxConfig
  | ImageSandboxConfig
  | FirecrackerSandboxConfig
  | CloudflareSandboxConfig
  | E2BSandboxConfig
  | GondolinSandboxConfig;

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

export interface E2BSandboxConfig {
  type: "e2b";
  template: string;
}

export interface GondolinSandboxConfig {
  type: "gondolin";
  profile?: string;
}

export interface Executor {
  /**
   * Execute a bash command.
   */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

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
  /**
   * Extra environment variables merged over the parent process env for
   * host-spawned commands. Used to hand secrets to child processes without
   * writing them to disk or the command line.
   */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}
