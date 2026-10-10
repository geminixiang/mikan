import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { OfficeAddress } from "../types.js";

export type SandboxConfig = HostSandboxConfig | ContainerSandboxConfig | ImageSandboxConfig;

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

export interface SandboxEnvOptions {
  cwd: string;
  env?: Record<string, string>;
  ensureReady?: () => Promise<void>;
  markUsed?: () => void;
}

export interface ContainerExecutionEnvOptions extends SandboxEnvOptions {
  container: string;
  engine?: string;
}

export interface RuntimePathContext {
  hostWorkspaceRoot: string;
  runtimeWorkspaceRoot: string;
  runtimeToHostPath?: (runtimePath: string) => string;
}

export type DockerExecFile = (file: string, args: string[]) => Promise<{ stdout: string }>;

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
  createEnv?(config: TConfig, options: SandboxEnvOptions): ExecutionEnv;
}
