import { containerSandboxAdapter } from "./container.js";
import { hostSandboxAdapter } from "./host.js";
import { createMountedRuntimePathContext, execSimple, SandboxError } from "./utils.js";
import { GUEST_WORKSPACE_ROOT } from "./layout.js";
import { containerEngine } from "./engine.js";
import * as log from "../log.js";
import { publishedSandboxImage } from "./published-image.js";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type {
  OciSandboxConfig,
  RuntimePathContext,
  SandboxAdapter,
  SandboxConfig,
  SandboxEnvOptions,
} from "./types.js";

const OCI_PREFIX = "oci:";
const DEPRECATED_OCI_PREFIX = "image:";
export const PUBLISHED_SANDBOX_SPEC = "oci";

function parseOciSandboxArg(value: string): OciSandboxConfig | undefined {
  if (value === PUBLISHED_SANDBOX_SPEC) {
    return { type: "oci", image: publishedSandboxImage() };
  }
  const deprecated = value.startsWith(DEPRECATED_OCI_PREFIX);
  if (!deprecated && !value.startsWith(OCI_PREFIX)) return undefined;
  const image = value.slice(deprecated ? DEPRECATED_OCI_PREFIX.length : OCI_PREFIX.length);
  if (!image) {
    throw new SandboxError("Error: oci sandbox requires an image (e.g., oci:ubuntu:24.04)");
  }
  if (deprecated) {
    log.logWarning(
      `--sandbox=${value} is deprecated`,
      `use --sandbox=${OCI_PREFIX}${image}; ${DEPRECATED_OCI_PREFIX} will be removed in the next major release`,
    );
  }
  return { type: "oci", image };
}

async function validateOciSandbox(config: OciSandboxConfig): Promise<void> {
  const engine = containerEngine();
  try {
    await execSimple(engine, ["--version"]);
  } catch {
    throw new SandboxError(
      `Error: no container engine found; install nerdctl, Podman, or Docker (tried '${engine}')`,
    );
  }
  console.log(`  OCI sandbox enabled. Image: ${config.image} (engine: ${engine})`);
}

const ociSandboxAdapter: SandboxAdapter<OciSandboxConfig> = {
  type: "oci",
  credentials: { env: true, fileMounts: true },
  workspace: { managedProjection: true },
  parse: parseOciSandboxArg,
  validate: validateOciSandbox,
};

const sandboxAdapters = [hostSandboxAdapter, containerSandboxAdapter, ociSandboxAdapter] as const;
const sandboxAdapterByType = new Map(
  sandboxAdapters.map((adapter) => [adapter.type, adapter]),
) as Map<SandboxConfig["type"], SandboxAdapter>;

function requireSandboxAdapter(type: SandboxConfig["type"]): SandboxAdapter {
  const adapter = sandboxAdapterByType.get(type);
  if (!adapter) throw new SandboxError(`Error: Unsupported sandbox type '${type}'`);
  return adapter;
}

export function getSandboxCredentialCapabilities(
  type: SandboxConfig["type"],
): SandboxAdapter["credentials"] {
  return requireSandboxAdapter(type).credentials;
}

function getSandboxWorkspaceCapabilities(type: SandboxConfig["type"]): SandboxAdapter["workspace"] {
  return requireSandboxAdapter(type).workspace;
}

const warnedUnenforcedPrivacy = new Set<string>();

export function warnUnenforcedPrivateOffice(
  sandboxConfig: SandboxConfig,
  visibility: "public" | "private",
  officeKey: string,
): void {
  const capabilities = getSandboxWorkspaceCapabilities(sandboxConfig.type);
  if (capabilities.managedProjection || visibility === "public") return;
  if (warnedUnenforcedPrivacy.has(officeKey)) return;
  warnedUnenforcedPrivacy.add(officeKey);
  log.logWarning(
    `Sandbox '${sandboxConfig.type}' cannot enforce private office visibility for ${officeKey}`,
    "host and container backends share one filesystem; use oci:* to isolate private channels and DMs",
  );
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
      `Error: '${value}' is not supported. Use 'container:<container-name>' for the shared-container mode or 'oci:<image>' for mikan-managed per-office containers.`,
    );
  }

  throw new SandboxError(
    `Error: Invalid sandbox type '${value}'. Use 'host', 'container:<container-name>', 'oci', or 'oci:<image>'`,
  );
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
  await requireSandboxAdapter(config.type).validate?.(config);
}

export function createSandboxEnv(config: SandboxConfig, options: SandboxEnvOptions): ExecutionEnv {
  const adapter = requireSandboxAdapter(config.type);
  if (!adapter.createEnv) {
    throw new SandboxError("Error: image sandbox must resolve to a concrete container");
  }
  return adapter.createEnv(config, options);
}

export function getSandboxPathContext(
  sandboxConfig: SandboxConfig,
  hostWorkspaceRoot: string,
): RuntimePathContext {
  return createMountedRuntimePathContext(
    hostWorkspaceRoot,
    sandboxConfig.type === "host" ? hostWorkspaceRoot : GUEST_WORKSPACE_ROOT,
  );
}
