import { createMountedRuntimePathContext, execSimple, SandboxError } from "./utils.js";
import { GUEST_WORKSPACE_ROOT } from "./layout.js";
import { containerEngine } from "./engine.js";
import * as log from "../log.js";
import { publishedSandboxImage } from "./published-image.js";
import type { RuntimePathContext, SandboxConfig } from "./types.js";

const OCI_PREFIX = "oci:";
const DEPRECATED_OCI_PREFIX = "image:";
const REMOVED_SPECS = /^(host$|container:|docker:)/;
export const PUBLISHED_SANDBOX_SPEC = "oci";

export function parseSandboxArg(value: string): SandboxConfig {
  if (value === PUBLISHED_SANDBOX_SPEC) return { image: publishedSandboxImage() };
  if (REMOVED_SPECS.test(value)) {
    throw new SandboxError(
      `Error: --sandbox=${value} is not supported. mikan runs each office in a container it manages: use '${PUBLISHED_SANDBOX_SPEC}' or '${OCI_PREFIX}<image>'`,
    );
  }
  const deprecated = value.startsWith(DEPRECATED_OCI_PREFIX);
  if (!deprecated && !value.startsWith(OCI_PREFIX)) {
    throw new SandboxError(
      `Error: Invalid sandbox '${value}'. Use '${PUBLISHED_SANDBOX_SPEC}' or '${OCI_PREFIX}<image>'`,
    );
  }
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
  return { image };
}

export async function validateSandbox(config: SandboxConfig): Promise<void> {
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

export function getSandboxPathContext(hostWorkspaceRoot: string): RuntimePathContext {
  return createMountedRuntimePathContext(hostWorkspaceRoot, GUEST_WORKSPACE_ROOT);
}
