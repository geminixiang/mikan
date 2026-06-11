import { SandboxError } from "./errors.js";
import { sanitizeScopeSegment } from "./scope.js";
import type { SandboxInstance, SandboxProvider } from "./spi.js";
import type { SandboxConfig } from "./types.js";
import { hostSandboxProvider } from "./providers/host.js";
import { containerSandboxProvider } from "./providers/docker/container.js";
import { createImageSandboxProvider, imageSandboxProvider } from "./providers/docker/image.js";
import type { DockerContainerManager } from "./providers/docker/provisioner.js";
import { firecrackerSandboxProvider } from "./providers/firecracker.js";
import { cloudflareSandboxProvider } from "./providers/cloudflare.js";
import { e2bSandboxProvider } from "./providers/e2b.js";
import { gondolinSandboxProvider } from "./providers/gondolin.js";

/** Runtime services a provider may need when acquiring managed instances. */
export interface SandboxProviderDeps {
  provisioner?: DockerContainerManager;
}

export type SandboxProviderFactory = (deps: SandboxProviderDeps) => SandboxProvider;

interface RegistryEntry {
  factory: SandboxProviderFactory;
  /** Deps-less instance used for parsing, validation, and capability lookups. */
  defaultProvider: SandboxProvider;
}

const entries: RegistryEntry[] = [
  { factory: () => hostSandboxProvider as SandboxProvider, defaultProvider: hostSandboxProvider },
  {
    factory: () => containerSandboxProvider as SandboxProvider,
    defaultProvider: containerSandboxProvider,
  },
  {
    factory: (deps) => createImageSandboxProvider(deps.provisioner) as SandboxProvider,
    defaultProvider: imageSandboxProvider,
  },
  {
    factory: () => firecrackerSandboxProvider as SandboxProvider,
    defaultProvider: firecrackerSandboxProvider,
  },
  {
    factory: () => cloudflareSandboxProvider as SandboxProvider,
    defaultProvider: cloudflareSandboxProvider,
  },
  {
    factory: () => e2bSandboxProvider as SandboxProvider,
    defaultProvider: e2bSandboxProvider,
  },
  {
    factory: () => gondolinSandboxProvider as SandboxProvider,
    defaultProvider: gondolinSandboxProvider,
  },
];

/**
 * Register a third-party sandbox provider (e.g. E2B, gondolin). The factory
 * receives runtime deps when the control plane builds an actor resolver.
 */
export function registerSandboxProvider(factory: SandboxProviderFactory): void {
  const defaultProvider = factory({});
  if (entries.some((entry) => entry.defaultProvider.type === defaultProvider.type)) {
    throw new SandboxError(
      `Error: sandbox provider type '${defaultProvider.type}' is already registered`,
    );
  }
  entries.push({ factory, defaultProvider });
}

export function getSandboxProviders(): readonly SandboxProvider[] {
  return entries.map((entry) => entry.defaultProvider);
}

export function getSandboxProvider(type: SandboxConfig["type"]): SandboxProvider {
  const entry = entries.find((candidate) => candidate.defaultProvider.type === type);
  if (!entry) {
    throw new SandboxError(`Error: Unsupported sandbox type '${type}'`);
  }
  return entry.defaultProvider;
}

/** Build a provider wired with runtime deps for the given config. */
export function createSandboxProviderFor(
  config: SandboxConfig,
  deps: SandboxProviderDeps = {},
): SandboxProvider {
  const entry = entries.find((candidate) => candidate.defaultProvider.type === config.type);
  if (!entry) {
    throw new SandboxError(`Error: Unsupported sandbox type '${config.type}'`);
  }
  return entry.factory(deps);
}

export function parseSandboxArg(value: string): SandboxConfig {
  for (const { defaultProvider } of entries) {
    const config = defaultProvider.parse(value);
    if (config) {
      return config;
    }
  }

  if (value.startsWith("docker:")) {
    throw new SandboxError(
      `Error: '${value}' is not supported. Use 'container:<container-name>' for the shared-container mode or 'image:<image-name>' for mikan-managed per-user containers.`,
    );
  }

  throw new SandboxError(`Error: Invalid sandbox type '${value}'. Use ${formatUsageList()}`);
}

function formatUsageList(): string {
  const usages = entries.map((entry) => `'${entry.defaultProvider.usage}'`);
  if (usages.length <= 1) return usages.join("");
  return `${usages.slice(0, -1).join(", ")}, or ${usages[usages.length - 1]}`;
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
  await getSandboxProvider(config.type).validate(config);
}

/**
 * Attach an executor directly to a sandbox config without actor context.
 * Managed-only configs (image:*) throw; use ActorExecutionResolver for those.
 */
export function createExecutor(
  config: SandboxConfig,
  env?: Record<string, string>,
  ensureReady?: () => Promise<void>,
): SandboxInstance {
  return getSandboxProvider(config.type).attach(config, env, ensureReady);
}

/**
 * Derive the credential/runtime scope key for an actor from the provider's
 * declared credential scope. This is the single place vault keys, managed
 * container names, and derived remote sandbox ids are routed from.
 */
export function resolveActorScopeKey(
  config: SandboxConfig,
  userId: string,
  conversationId: string,
): string {
  const provider = getSandboxProvider(config.type);
  switch (provider.capabilities.credentialScope) {
    case "user":
      return userId;
    case "conversation":
      return sanitizeScopeSegment(conversationId);
    case "instance": {
      if (!provider.instanceScopeKey) {
        throw new SandboxError(
          `Error: sandbox provider '${provider.type}' declares instance scope but no instanceScopeKey()`,
        );
      }
      return provider.instanceScopeKey(config);
    }
  }
}
