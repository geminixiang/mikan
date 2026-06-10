import type { ContainerMount } from "../types.js";
import type { Executor, RuntimePathContext, SandboxConfig } from "./types.js";

/**
 * Who owns the lifecycle of the runtime behind a sandbox config.
 * - "external": the user manages the runtime (existing container, VM, host shell).
 * - "managed": mikan acquires/provisions a runtime per scope key.
 */
export type SandboxLifecycle = "external" | "managed";

/**
 * The scope that credentials (vault entries) and managed runtimes are keyed by.
 * - "user": one scope per platform user (host mode).
 * - "conversation": one scope per conversation (managed/per-conversation runtimes).
 * - "instance": one scope per concrete runtime named in the config (shared container).
 */
export type CredentialScope = "user" | "conversation" | "instance";

export interface SandboxCapabilities {
  lifecycle: SandboxLifecycle;
  credentialScope: CredentialScope;
  /**
   * How vault env vars reach the runtime.
   * - "none": env is never injected.
   * - "per-exec": injected on every command execution.
   * - "at-create": injected once when the instance/session is established.
   */
  envInjection: "none" | "per-exec" | "at-create";
  /** Whether vault files can be projected into the runtime via bind mounts. */
  fileMounts: boolean;
  /** Whether vault files can be pushed into the runtime via the instance fs API. */
  filePush: boolean;
  /** Whether env secrets can stay host-side and be substituted only on approved egress. */
  egressBroker: boolean;
}

/** The actor a sandbox instance is being acquired for. */
export interface ActorRef {
  userId: string;
  conversationId: string;
}

/** Control-plane context handed to a provider when acquiring an instance. */
export interface AcquireContext extends ActorRef {
  /** Credential/runtime scope key derived via resolveActorScopeKey(). */
  scopeKey: string;
  /** Vault env to inject, already filtered by the provider's capabilities. */
  env?: Record<string, string>;
  /** Bind mounts (workspace + vault files); only set when capabilities.fileMounts. */
  mounts?: ContainerMount[];
}

/** Minimal filesystem surface for pushing files into a sandbox runtime. */
export interface SandboxFs {
  /** Recursively create a directory inside the runtime. */
  mkdir(path: string): Promise<void>;
  /** Write a private (0600) text file inside the runtime. */
  writeFile(path: string, content: string): Promise<void>;
}

/**
 * A ready-to-use sandbox runtime. Supersets the legacy Executor contract so
 * tools (bash/read/write/edit) keep working against any provider.
 */
export interface SandboxInstance extends Executor {
  /** Stable identifier of the underlying runtime (container name, sandbox id, "host"). */
  readonly id: string;
  /** Filesystem push API; present when the provider declares capabilities.filePush. */
  readonly fs?: SandboxFs;
  /** Stop the runtime while keeping it resumable (e.g. docker stop). */
  suspend?(): Promise<void>;
  /** Remove the runtime and its associated resources. */
  destroy?(): Promise<void>;
}

/**
 * A sandbox backend. Providers own everything backend-specific: config
 * parsing, validation, runtime acquisition, and path semantics. The control
 * plane only consults `capabilities` and never switches on config types.
 */
export interface SandboxProvider<TConfig extends SandboxConfig = SandboxConfig> {
  readonly type: TConfig["type"];
  readonly capabilities: SandboxCapabilities;
  /** CLI usage hint, e.g. "container:<container-name>". */
  readonly usage: string;

  /** Parse a CLI sandbox argument; return undefined when the value targets another provider. */
  parse(value: string): TConfig | undefined;
  /** Validate environment prerequisites at startup (binaries, reachability, ...). */
  validate(config: TConfig): Promise<void>;
  /** Path semantics for this config without acquiring a runtime. */
  getPathContext(config: TConfig, hostWorkspaceRoot: string): RuntimePathContext;
  /** Scope key for credentialScope "instance" providers, derived from the config. */
  instanceScopeKey?(config: TConfig): string;

  /**
   * Acquire a ready instance for an actor. Managed providers provision or
   * connect to the runtime keyed by ctx.scopeKey; external providers attach
   * to the runtime named in the config.
   */
  acquire(config: TConfig, ctx: AcquireContext): Promise<SandboxInstance> | SandboxInstance;

  /**
   * Attach directly to the runtime named in the config without actor context
   * (CLI/compat path). Managed-only configs (image:*) throw.
   */
  attach(
    config: TConfig,
    env?: Record<string, string>,
    ensureReady?: () => Promise<void>,
  ): SandboxInstance;
}
