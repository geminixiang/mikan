import { ContainerExecutor, containerSandboxAdapter } from "./container.js";
import { CloudflareSandboxExecutor, cloudflareSandboxAdapter } from "./cloudflare.js";
import { HostExecutor, hostSandboxAdapter } from "./host.js";
import { createMountedRuntimePathContext, execSimple, SandboxError } from "./utils.js";
import type {
  Executor,
  ImageSandboxConfig,
  RuntimePathContext,
  SandboxAdapter,
  SandboxConfig,
} from "./types.js";

export type {
  CloudflareSandboxConfig,
  ExecOptions,
  ExecResult,
  Executor,
  RuntimePathContext,
  SandboxAdapter,
  SandboxConfig,
} from "./types.js";
export { CloudflareSandboxExecutor, ContainerExecutor, HostExecutor };
export { SandboxError } from "./utils.js";

function parseImageSandboxArg(value: string): ImageSandboxConfig | undefined {
  if (!value.startsWith("image:")) {
    return undefined;
  }

  const image = value.slice("image:".length);
  if (!image) {
    throw new SandboxError("Error: image sandbox requires image name (e.g., image:ubuntu:24.04)");
  }
  return { type: "image", image };
}

async function validateImageSandbox(config: ImageSandboxConfig): Promise<void> {
  try {
    await execSimple("docker", ["--version"]);
  } catch {
    throw new SandboxError("Error: Docker is not installed or not in PATH");
  }
  console.log(`  Image auto-provisioning enabled. Image: ${config.image}`);
}

const imageSandboxAdapter: SandboxAdapter<ImageSandboxConfig> = {
  type: "image",
  credentials: { env: true, fileMounts: true },
  workspace: { managedProjection: true },
  parse: parseImageSandboxArg,
  validate: validateImageSandbox,
};

const sandboxAdapters = [
  hostSandboxAdapter,
  containerSandboxAdapter,
  imageSandboxAdapter,
  cloudflareSandboxAdapter,
] as const;
const sandboxAdapterByType = new Map(
  sandboxAdapters.map((adapter) => [adapter.type, adapter]),
) as Map<SandboxConfig["type"], SandboxAdapter>;

export function getSandboxAdapters(): readonly [...typeof sandboxAdapters] {
  return sandboxAdapters;
}

export function getSandboxCredentialCapabilities(
  type: SandboxConfig["type"],
): SandboxAdapter["credentials"] {
  const adapter = sandboxAdapterByType.get(type);
  if (!adapter) throw new SandboxError(`Error: Unsupported sandbox type '${type}'`);
  return adapter.credentials;
}

export function getSandboxWorkspaceCapabilities(
  type: SandboxConfig["type"],
): SandboxAdapter["workspace"] {
  const adapter = sandboxAdapterByType.get(type);
  if (!adapter) throw new SandboxError(`Error: Unsupported sandbox type '${type}'`);
  return adapter.workspace;
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
      `Sandbox '${sandboxConfig.type}' cannot provide an isolated conversation office; use image:*, or explicitly choose trusted workspace policy`,
    );
  }
}

export function parseSandboxArg(value: string): SandboxConfig {
  for (const adapter of sandboxAdapters) {
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
    `Error: Invalid sandbox type '${value}'. Use 'host', 'container:<container-name>', 'image:<image-name>', or 'cloudflare:<sandbox-id>'`,
  );
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
  const adapter = sandboxAdapterByType.get(config.type);
  if (!adapter) {
    throw new SandboxError(`Error: Unsupported sandbox type '${config.type}'`);
  }

  await adapter.validate?.(config);
}

/**
 * Create an executor that runs commands on host, in Docker, or through a
 * Cloudflare sandbox bridge.
 */
export function createExecutor(
  config: SandboxConfig,
  env?: Record<string, string>,
  ensureReady?: () => Promise<void>,
): Executor {
  const adapter = sandboxAdapterByType.get(config.type);
  if (!adapter) {
    throw new SandboxError(`Error: Unsupported sandbox type '${config.type}'`);
  }
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
