import type { Readable, Writable } from "node:stream";

export interface SandboxConfig {
  image: string;
}

interface SandboxEnvOptions {
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
