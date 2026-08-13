import type { ImageSandboxConfig, SandboxAdapter } from "./types.js";
import { SandboxError } from "./errors.js";
import { execSimple } from "./utils.js";
import { DockerContainerManager } from "../provisioner.js";
import { reportUserFacingError } from "../observability/sentry.js";

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

export const imageSandboxAdapter: SandboxAdapter<ImageSandboxConfig> = {
  type: "image",
  credentials: { env: true, fileMounts: true },
  workspace: { managedProjection: true },
  vault: { routingLabel: "conversation", ambientSharedVault: true },
  parse: parseImageSandboxArg,
  validate: validateImageSandbox,
  provisionerImage: (config) => config.image,
  resolveRuntimeConfig: (config, { resourceKey }) => ({
    type: "container",
    container: DockerContainerManager.containerName(resourceKey),
  }),
  createEnsureReady: (
    config,
    { provisioner, resourceKey, credentialKey, mounts, conversationId, hasVault },
  ) => {
    if (!provisioner) return undefined;
    const expected = DockerContainerManager.containerName(resourceKey);
    return async () => {
      let actual: string | undefined;
      try {
        actual = await provisioner.provision(resourceKey, {
          containerName: expected,
          mounts,
          conversationId,
        });
      } catch (err) {
        reportUserFacingError(err, {
          domain: "sandbox",
          surface: "sandbox_provision",
          operation: "ensure_image_container_ready",
          severity: "error",
          context: {
            sandboxType: "image",
            conversationId,
            credentialKey,
            resourceKey,
            expectedContainer: expected,
            hasVault,
          },
        });
        throw err;
      }
      if (actual && actual !== expected) {
        throw new Error(
          `Provisioner returned container "${actual}" for resource key "${resourceKey}", expected "${expected}"`,
        );
      }
    };
  },
  createResourceController: ({ provisioner }) => provisioner,
  describe: (config) => `image:${config.image}`,
};
