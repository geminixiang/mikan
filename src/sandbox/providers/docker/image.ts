import type { ImageSandboxConfig } from "../../types.js";
import type { AcquireContext, SandboxProvider } from "../../spi.js";
import { SandboxError } from "../../errors.js";
import { execSimple } from "../../utils.js";
import { createMountedRuntimePathContext } from "../../path-context.js";
import { reportUserFacingError } from "../../../observability/sentry.js";
import { ContainerExecutor } from "./container.js";
import { DockerContainerManager } from "./provisioner.js";

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

/** A per-scope managed container whose lifecycle mikan owns via the provisioner. */
class ManagedContainerInstance extends ContainerExecutor {
  constructor(
    containerName: string,
    private readonly scopeKey: string,
    private readonly provisioner: DockerContainerManager | undefined,
    env?: Record<string, string>,
    ensureReady?: () => Promise<void>,
  ) {
    super(containerName, env, ensureReady);
  }

  async suspend(): Promise<void> {
    await this.provisioner?.stop(this.scopeKey);
  }

  async destroy(): Promise<void> {
    await this.provisioner?.remove(this.scopeKey);
  }
}

export function createImageSandboxProvider(
  provisioner?: DockerContainerManager,
): SandboxProvider<ImageSandboxConfig> {
  return {
    type: "image",
    usage: "image:<image-name>",
    capabilities: {
      lifecycle: "managed",
      credentialScope: "conversation",
      envInjection: "per-exec",
      fileMounts: true,
      filePush: false,
      egressBroker: false,
    },
    parse: parseImageSandboxArg,
    validate: validateImageSandbox,
    getPathContext: (_config, hostWorkspaceRoot) =>
      createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace"),
    acquire: (config, ctx) => {
      const containerName = DockerContainerManager.containerName(ctx.scopeKey);
      return new ManagedContainerInstance(
        containerName,
        ctx.scopeKey,
        provisioner,
        ctx.env,
        buildEnsureReady(containerName, provisioner, ctx),
      );
    },
    attach: () => {
      throw new SandboxError("Error: image sandbox must resolve to a concrete container executor");
    },
  };
}

function buildEnsureReady(
  expected: string,
  provisioner: DockerContainerManager | undefined,
  ctx: AcquireContext,
): () => Promise<void> {
  return async () => {
    let actual: string | undefined;
    try {
      actual = await provisioner?.provision(ctx.scopeKey, {
        containerName: expected,
        mounts: ctx.mounts ?? [],
        conversationId: ctx.conversationId,
      });
    } catch (err) {
      reportUserFacingError(err, {
        domain: "sandbox",
        surface: "sandbox_provision",
        operation: "ensure_image_container_ready",
        severity: "error",
        context: {
          sandboxType: "image",
          resolvedSandboxType: "container",
          conversationId: ctx.conversationId,
          vaultKey: ctx.scopeKey,
          expectedContainer: expected,
          hasVault: Boolean(ctx.env || ctx.mounts?.length),
        },
      });
      throw err;
    }
    if (actual && actual !== expected) {
      throw new Error(
        `Provisioner returned container "${actual}" for container key "${ctx.scopeKey}", expected "${expected}"`,
      );
    }
  };
}

/** Stateless instance used for parsing/validation before a provisioner exists. */
export const imageSandboxProvider = createImageSandboxProvider();
