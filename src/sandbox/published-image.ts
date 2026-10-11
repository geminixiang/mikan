import { packageVersion } from "../package-version.js";

const PUBLISHED_SANDBOX_REPOSITORY = "ghcr.io/geminixiang/mikan-sandbox";

export function publishedSandboxImage(): string {
  return `${PUBLISHED_SANDBOX_REPOSITORY}:${packageVersion()}`;
}

export function isPublishedSandboxImage(reference: string): boolean {
  return reference.startsWith(`${PUBLISHED_SANDBOX_REPOSITORY}:`);
}
