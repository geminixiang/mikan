import type { Readable, Writable } from "node:stream";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { OfficeAddress } from "../types.js";

export type SandboxConfig = HostSandboxConfig | ContainerSandboxConfig | OciSandboxConfig;

export interface HostSandboxConfig {
  type: "host";
}

export interface ContainerSandboxConfig {
  type: "container";
  container: string;
}

export interface OciSandboxConfig {
  type: "oci";
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

export type BrowserOwner = "agent" | "user";

export interface DesktopStatus {
  display?: string;
  control: BrowserOwner;
}

export type DesktopStart = "ready" | "outdated-image" | "stopped";

export interface DesktopProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  kill(): unknown;
  once(event: "exit" | "error", listener: () => void): unknown;
}

export interface DesktopStream {
  input: Writable;
  output: Readable;
  process: Pick<DesktopProcess, "once">;
  close(): void;
}
