import {
  setOfficeVisibilityOverride,
  updateConversationSettings,
  updateGlobalSettings,
} from "./index.js";
import type { Office } from "../office/types.js";
import type {
  AgentConfig,
  GlobalRunnerCacheControl,
  OfficeAddress,
  RunnerCacheControl,
  SettingsApplyResult,
} from "../types.js";

function affectsCachedRunner(patch: Partial<AgentConfig>): boolean {
  return (
    patch.provider !== undefined ||
    patch.model !== undefined ||
    patch.thinkingLevel !== undefined ||
    patch.mcpServers !== undefined
  );
}

export function applyConversationSettings(
  runtime: RunnerCacheControl | undefined,
  office: Office,
  patch: Partial<AgentConfig>,
): SettingsApplyResult {
  let runtimeSwitched: boolean | null = null;
  if (affectsCachedRunner(patch) && runtime) {
    if (!runtime.refreshConversation(office.address)) return { ok: false };
    runtimeSwitched = true;
  }
  updateConversationSettings(office, patch);
  return { ok: true, runtimeSwitched };
}

export function applyGlobalSettings(
  runtime: GlobalRunnerCacheControl | undefined,
  stateDir: string,
  patch: Partial<AgentConfig>,
): { ok: true; staleConversations: OfficeAddress[] } {
  updateGlobalSettings(stateDir, patch);
  const staleConversations =
    affectsCachedRunner(patch) && runtime ? runtime.refreshAllConversations().busy : [];
  return { ok: true, staleConversations };
}

export function applyOfficeVisibility(
  runtime: RunnerCacheControl | undefined,
  office: Office,
  visibility: "private" | null,
): SettingsApplyResult {
  if (runtime && !runtime.refreshConversation(office.address)) {
    return { ok: false };
  }
  setOfficeVisibilityOverride(office, visibility);
  return { ok: true, runtimeSwitched: runtime ? true : null };
}
