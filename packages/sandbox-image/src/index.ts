/**
 * @geminixiang/mikan-sandbox-image — the mikan image sandbox backend as a
 * plugin: `image:<image>` configs auto-provision a per-conversation container
 * from the base image. The adapter declares the provisioner image and the
 * image → container resolution; the core provisions via the injected
 * `SandboxProvisioner` (the daemon's DockerContainerManager) and supplies the
 * resulting container executor.
 */

import {
  SandboxError,
  execSimple,
  managedContainerName,
  type SandboxAdapter,
} from "@geminixiang/mikan-sandbox-contract";

/** The image backend's own config. */
export interface ImageSandboxConfig {
  type: "image";
  image: string;
}

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
    container: managedContainerName(resourceKey),
  }),
  createEnsureReady: (config, { provisioner, resourceKey, mounts, conversationId }) => {
    if (!provisioner) return undefined;
    const expected = managedContainerName(resourceKey);
    return async () => {
      const actual = await provisioner.provision(resourceKey, {
        containerName: expected,
        mounts,
        conversationId,
      });
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
