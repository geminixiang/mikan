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
 * - Every writable top-level key is exhaustively classified below. Sandbox and
 *   Slack settings are re-read at use time, packages apply to the next harness
 *   instance, and Sentry DSN changes apply to the next process.
 * - Global changes always write (the Admin default surface), then clear every
 *   idle conversation's cached runners; conversations that were busy keep
 *   their old runner until it settles, are reported as stale, and are cleared
 *   automatically before their next turn.
 */
import {
  setConversationWorkspacePolicy,
  setGlobalWorkspacePolicy,
  updateConversationSettings,
  updateGlobalSettings,
  type WorkspacePolicyChoice,
} from "./config.js";
import type { Office } from "./office/index.js";
import type {
  AgentConfig,
  GlobalRunnerCacheControl,
  OfficeAddress,
  RunnerCacheControl,
  SettingsApplyResult,
} from "./types.js";

export type { GlobalRunnerCacheControl, RunnerCacheControl, SettingsApplyResult } from "./types.js";

type SettingsMutationLifecycle = "runner-cache" | "next-use" | "next-harness" | "next-process";

/**
 * Every writable AgentConfig key must declare when its new value takes effect.
 * `satisfies` intentionally makes an AgentConfig addition a compile error until
 * its lifecycle is classified here.
 */
const SETTINGS_MUTATION_LIFECYCLE = {
  provider: "runner-cache",
  model: "runner-cache",
  thinkingLevel: "runner-cache",
  sentryDsn: "next-process",
  sandbox: "next-use",
  slack: "next-use",
  packages: "next-harness",
} as const satisfies Record<keyof AgentConfig, SettingsMutationLifecycle>;

function mutationLifecycles(patch: Partial<AgentConfig>): SettingsMutationLifecycle[] {
  return Object.entries(patch).flatMap(([key, value]) => {
    if (value === undefined) return [];
    if (!Object.hasOwn(SETTINGS_MUTATION_LIFECYCLE, key)) {
      throw new Error(`Unsupported settings mutation key: ${key}`);
    }
    return [SETTINGS_MUTATION_LIFECYCLE[key as keyof AgentConfig]];
  });
}

/** True when a patch touches keys a cached session runner bakes in. */
function affectsCachedRunner(patch: Partial<AgentConfig>): boolean {
  return mutationLifecycles(patch).includes("runner-cache");
}

export function applyConversationSettings(
  runtime: RunnerCacheControl | undefined,
  office: Office,
  patch: Partial<AgentConfig>,
): SettingsApplyResult {
  let runtimeSwitched: boolean | null = null;
  if (affectsCachedRunner(patch) && runtime) {
    // Clear-or-refuse before writing. The clear and the write happen in the
    // same synchronous tick, so no runner can be created in between.
    if (!runtime.switchConversationModel(office.address, patch.provider ?? "", patch.model ?? "")) {
      return { ok: false, reason: "busy" };
    }
    runtimeSwitched = true;
  }
  updateConversationSettings(office, patch);
  return { ok: true, runtimeSwitched };
}

export function applyGlobalSettings(
  runtime: GlobalRunnerCacheControl | undefined,
  patch: Partial<AgentConfig>,
): { ok: true; staleConversations: OfficeAddress[] } {
  const refreshRunners = affectsCachedRunner(patch);
  updateGlobalSettings(patch);
  const staleConversations =
    refreshRunners && runtime ? runtime.refreshAllConversations().busy : [];
  return { ok: true, staleConversations };
}

/**
 * Door-policy changes follow the same clear-or-refuse contract as model
 * changes: the system prompt bakes the workspace projection (layout line,
 * memory and skill guidance), so the cached runner must clear before the
 * write, and the container is re-provisioned on the next message when its
 * mount signature no longer matches.
 */
export function applyConversationWorkspacePolicy(
  runtime: RunnerCacheControl | undefined,
  office: Office,
  choice: WorkspacePolicyChoice | null,
): SettingsApplyResult {
  if (runtime && !runtime.refreshConversationEnvironment(office.address)) {
    return { ok: false, reason: "busy" };
  }
  setConversationWorkspacePolicy(office, choice);
  return { ok: true, runtimeSwitched: runtime ? true : null };
}

export function applyGlobalWorkspacePolicy(
  runtime: GlobalRunnerCacheControl | undefined,
  choice: WorkspacePolicyChoice | null,
): { ok: true; staleConversations: OfficeAddress[] } {
  setGlobalWorkspacePolicy(choice);
  const staleConversations = runtime ? runtime.refreshAllConversations().busy : [];
  return { ok: true, staleConversations };
}
