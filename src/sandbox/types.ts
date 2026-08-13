import type {
  ResourceLimits,
  SandboxAdapter as ContractSandboxAdapter,
} from "@geminixiang/mikan-sandbox-contract";
import type { HostSandboxConfig } from "@geminixiang/mikan-sandbox-host";

export type SandboxConfig =
  | HostSandboxConfig
  | ContainerSandboxConfig
  | ImageSandboxConfig
  | GondolinSandboxConfig
  | FirecrackerSandboxConfig
  | CloudflareSandboxConfig;

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

// The sandbox contract (Executor, RuntimePathContext, capabilities, adapter
// surface, boot/resolution contexts) lives in
// @geminixiang/mikan-sandbox-contract — the single home both the daemon core
// and sandbox plugins compile against. Re-exported here so existing daemon
// import sites keep working; the adapter's and executor's default config is
// this module's closed built-in union.
export type {
  ExecOptions,
  ExecResult,
  RuntimePathContext,
  SandboxBootContext,
  SandboxControllerContext,
  SandboxCredentialCapabilities,
  SandboxProvisioner,
  SandboxReadyContext,
  SandboxResolutionContext,
  SandboxVaultCapabilities,
} from "@geminixiang/mikan-sandbox-contract";
import type { Executor as ContractExecutor } from "@geminixiang/mikan-sandbox-contract";

/** Executor whose `getSandboxConfig` returns the daemon's built-in union by default. */
export type Executor<TConfig extends { type: string } = SandboxConfig> = ContractExecutor<TConfig>;

export type SandboxAdapter<TConfig extends { type: string } = SandboxConfig> =
  ContractSandboxAdapter<TConfig>;
