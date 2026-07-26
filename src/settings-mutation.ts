/**
 * The one writer seam for settings mutations that affect live conversations.
 * Chat commands (/model, /sandbox) and the Admin portal are adapters here;
 * none of them call updateConversationSettings/updateGlobalSettings directly
 * for these keys anymore.
 *
 * Policy, uniform across all adapters:
 * - llm.* changes bake into cached session runners, so a conversation-scoped
 *   change clears the conversation's cached runners BEFORE writing — and
 *   refuses (no write, no clear) while the conversation has a running job.
 *   Disk and cache never disagree.
 * - Other keys (sandbox mount, slack replyMode, limits) are re-read at use
 *   time and write without touching runners.
 * - Global changes always write (the Admin default surface), then clear every
 *   idle conversation's cached runners; conversations that were busy keep
 *   their old runner until it settles, are reported as stale, and are cleared
 *   automatically before their next turn.
 */
import { join } from "path";
import { updateConversationSettings, updateGlobalSettings } from "./config.js";
import type {
  AgentConfig,
  GlobalRunnerCacheControl,
  RunnerCacheControl,
  SettingsApplyResult,
} from "./types.js";

export type { GlobalRunnerCacheControl, RunnerCacheControl, SettingsApplyResult } from "./types.js";

/** True when a patch touches keys a cached session runner bakes in. */
function affectsCachedRunner(patch: Partial<AgentConfig>): boolean {
  return (
    patch.provider !== undefined || patch.model !== undefined || patch.thinkingLevel !== undefined
  );
}

export function applyConversationSettings(
  runtime: RunnerCacheControl | undefined,
  workingDir: string,
  conversationId: string,
  patch: Partial<AgentConfig>,
): SettingsApplyResult {
  let runtimeSwitched: boolean | null = null;
  if (affectsCachedRunner(patch) && runtime) {
    // Clear-or-refuse before writing. The clear and the write happen in the
    // same synchronous tick, so no runner can be created in between.
    if (!runtime.switchConversationModel(conversationId, patch.provider ?? "", patch.model ?? "")) {
      return { ok: false, reason: "busy" };
    }
    runtimeSwitched = true;
  }
  updateConversationSettings(join(workingDir, conversationId), patch);
  return { ok: true, runtimeSwitched };
}

export function applyGlobalSettings(
  runtime: GlobalRunnerCacheControl | undefined,
  patch: Partial<AgentConfig>,
): { ok: true; staleConversations: string[] } {
  updateGlobalSettings(patch);
  const staleConversations =
    affectsCachedRunner(patch) && runtime ? runtime.refreshAllConversations().busy : [];
  return { ok: true, staleConversations };
}
