import type { PlatformTrustModel } from "../types.js";
import type { SandboxConfig } from "../sandbox/index.js";

/**
 * Decide whether a new conversation vault may inherit `sandbox.defaultSharedVault`.
 *
 * Ambient copy is a membership-trust convenience: only appropriate when the
 * people who can drive the agent are already gated by platform membership
 * (Slack/Discord/Telegram). Open-trigger surfaces (GitHub issue/PR comments)
 * must not inherit ambient credentials — host-side platform identity or an
 * explicitly provisioned vault only.
 *
 * Topology: only isolated sandboxes (`image` / `cloudflare`) auto-provision
 * per-conversation vaults that receive the copy. `host` / `container` /
 * `firecracker` do not use this ambient path.
 */
export function allowsAmbientDefaultSharedVault(options: {
  trustModel?: PlatformTrustModel;
  sandboxType: SandboxConfig["type"];
}): boolean {
  const trustModel = options.trustModel ?? "membership";
  if (trustModel === "open-trigger") return false;
  return options.sandboxType === "image" || options.sandboxType === "cloudflare";
}
