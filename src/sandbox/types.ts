import type { OfficeAddress } from "../types.js";

export type SandboxConfig =
  | HostSandboxConfig
  | ContainerSandboxConfig
  | ImageSandboxConfig
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

export interface CloudflareSandboxConfig {
  type: "cloudflare";
  sandboxId: string;
}

export interface Executor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  readFile(path: string, options?: ExecOptions): Promise<string>;

  readFileBase64(path: string, options?: ExecOptions): Promise<string>;

  writeFile(path: string, content: string, options?: ExecOptions): Promise<void>;

  getWorkspacePath(hostPath: string): string;

  getPathContext(hostWorkspaceRoot: string): RuntimePathContext;

  getSandboxConfig(): SandboxConfig;
}

export interface RuntimePathContext {
  hostWorkspaceRoot: string;
  runtimeWorkspaceRoot: string;
  runtimeToHostPath?: (runtimePath: string) => string;
}

export interface ExecOptions {
  timeout?: number;
  cwd?: string;
  signal?: AbortSignal;
}

export type DockerExecFile = (file: string, args: string[]) => Promise<{ stdout: string }>;

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SandboxCredentialCapabilities {
  env: boolean;
  fileMounts: boolean;
}

export interface CredentialScope {
  userId: string;
  address: OfficeAddress;
}

interface SandboxWorkspaceCapabilities {
  managedProjection: boolean;
}

export interface SandboxAdapter<TConfig extends SandboxConfig = SandboxConfig> {
  type: TConfig["type"];
  credentials: SandboxCredentialCapabilities;
  workspace: SandboxWorkspaceCapabilities;
  parse(value: string): TConfig | undefined;
  validate?(config: TConfig): Promise<void>;
  createExecutor?(
    config: TConfig,
    env?: Record<string, string>,
    ensureReady?: () => Promise<void>,
  ): Executor;
}
