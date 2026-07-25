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
 * Sandbox mode: `image:*` only. This is a trust rule, not a topology rule —
 * inheriting one shared credential set suits a trusted internal team, which
 * is what `image:*` deployments are. Do NOT widen this to whichever modes
 * happen to be isolated and per-conversation: that reasoning is how
 * `agent-sandbox` was added here in 19845f7, and it would pull in `gondolin`
 * too, whose whole point is running code from people you do not trust.
 */
export function allowsAmbientDefaultSharedVault(options: {
  trustModel?: PlatformTrustModel;
  sandboxType: SandboxConfig["type"];
}): boolean {
  const trustModel = options.trustModel ?? "membership";
  if (trustModel === "open-trigger") return false;
  return options.sandboxType === "image";
}
