import { FirecrackerExecutor, firecrackerSandboxAdapter } from "./firecracker.js";
import { CloudflareSandboxExecutor, cloudflareSandboxAdapter } from "./cloudflare.js";
import { GondolinExecutor, gondolinSandboxAdapter } from "./gondolin.js";
import { SandboxError, createMountedRuntimePathContext } from "@geminixiang/mikan-sandbox-contract";
import { HostExecutor, hostSandboxAdapter } from "@geminixiang/mikan-sandbox-host";
import { ContainerExecutor, containerSandboxAdapter } from "@geminixiang/mikan-sandbox-container";
import { imageSandboxAdapter } from "@geminixiang/mikan-sandbox-image";
export { configureGondolinRuntime } from "./gondolin.js";
export type { GondolinBootstrapOptions } from "./types.js";
import type { Executor, RuntimePathContext, SandboxAdapter, SandboxConfig } from "./types.js";

export type {
  CloudflareSandboxConfig,
  ExecOptions,
  ExecResult,
  Executor,
  RuntimePathContext,
  SandboxAdapter,
  SandboxBootContext,
  SandboxConfig,
  SandboxControllerContext,
  SandboxCredentialCapabilities,
  SandboxProvisioner,
  SandboxReadyContext,
  SandboxResolutionContext,
  SandboxVaultCapabilities,
} from "./types.js";
export {
  CloudflareSandboxExecutor,
  ContainerExecutor,
  FirecrackerExecutor,
  HostExecutor,
  GondolinExecutor,
};
export { SandboxError } from "@geminixiang/mikan-sandbox-contract";

const builtInSandboxAdapters: readonly SandboxAdapter[] = [
  hostSandboxAdapter,
  containerSandboxAdapter,
  imageSandboxAdapter,
  gondolinSandboxAdapter,
  firecrackerSandboxAdapter,
  cloudflareSandboxAdapter,
];
const sandboxAdapterByType = new Map<string, SandboxAdapter>(
  builtInSandboxAdapters.map((adapter) => [adapter.type, adapter] as const),
);

export function getSandboxAdapters(): readonly SandboxAdapter[] {
  return [...sandboxAdapterByType.values()];
}

/**
 * Register an additional sandbox backend (plugin). Duplicate type names
 * throw — the type is the composition-level identity.
 */
export function registerSandboxAdapter(adapter: SandboxAdapter): void {
  if (sandboxAdapterByType.has(adapter.type)) {
    throw new SandboxError(`Sandbox adapter '${adapter.type}' is already registered`);
  }
  sandboxAdapterByType.set(adapter.type, adapter);
}

/** The adapter for a sandbox type; throws for unknown types. */
export function getSandboxAdapter(type: string): SandboxAdapter {
  const adapter = sandboxAdapterByType.get(type);
  if (!adapter) throw new SandboxError(`Error: Unsupported sandbox type '${type}'`);
  return adapter;
}

export function getSandboxCredentialCapabilities(
  type: SandboxConfig["type"],
): SandboxAdapter["credentials"] {
  return getSandboxAdapter(type).credentials;
}

export function getSandboxWorkspaceCapabilities(
  type: SandboxConfig["type"],
): SandboxAdapter["workspace"] {
  return getSandboxAdapter(type).workspace;
}

export function assertSandboxSupportsWorkspacePolicy(
  sandboxConfig: SandboxConfig,
  doorPolicy: "isolated" | "trusted",
): void {
  if (
    doorPolicy === "isolated" &&
    !getSandboxWorkspaceCapabilities(sandboxConfig.type).managedProjection
  ) {
    throw new SandboxError(
      `Sandbox '${sandboxConfig.type}' cannot provide an isolated conversation office; use image:* or gondolin:default, or explicitly choose trusted workspace policy`,
    );
  }
}

export function parseSandboxArg(value: string): SandboxConfig {
  for (const adapter of sandboxAdapterByType.values()) {
    const config = adapter.parse(value);
    if (config) {
      return config;
    }
  }

  if (value.startsWith("docker:")) {
    throw new SandboxError(
      `Error: '${value}' is not supported. Use 'container:<container-name>' for the shared-container mode or 'image:<image-name>' for mikan-managed per-user containers.`,
    );
  }

  throw new SandboxError(
    `Error: Invalid sandbox type '${value}'. Use 'host', 'container:<container-name>', 'image:<image-name>', 'gondolin:default', 'firecracker:<vm-id>:<host-path>', or 'cloudflare:<sandbox-id>'`,
  );
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
  await getSandboxAdapter(config.type).validate?.(config);
}

/**
 * Create an executor that runs commands on host, in Docker, in a microVM, in a Firecracker VM, or through a Cloudflare sandbox bridge.
 */
export function createExecutor(
  config: SandboxConfig,
  env?: Record<string, string>,
  ensureReady?: () => Promise<void>,
): Executor {
  const adapter = getSandboxAdapter(config.type);
  if (!adapter.createExecutor) {
    throw new SandboxError("Error: image sandbox must resolve to a concrete container executor");
  }
  return adapter.createExecutor(config, env, ensureReady);
}

/**
 * The runtime path context for a sandbox config before an actor-specific
 * executor is resolved. `image` configs are unresolved by nature (the actor
 * decides the concrete container), but their mount layout is fixed, so path
 * mapping is known without resolving.
 */
export function getUnresolvedSandboxPathContext(
  sandboxConfig: SandboxConfig,
  hostWorkspaceRoot: string,
): RuntimePathContext {
  if (sandboxConfig.type === "image") {
    return createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace");
  }

  return createExecutor(sandboxConfig).getPathContext(hostWorkspaceRoot);
}
