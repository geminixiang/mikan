import type { ImageSandboxConfig, SandboxAdapter } from "./types.js";
import { SandboxError } from "./errors.js";
import { execSimple } from "./utils.js";

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
  parse: parseImageSandboxArg,
  validate: validateImageSandbox,
};
