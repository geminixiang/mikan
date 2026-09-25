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
  updateGlobalSettings(patch);
  const staleConversations =
    affectsCachedRunner(patch) && runtime ? runtime.refreshAllConversations().busy : [];
  return { ok: true, staleConversations };
}

export function applyOfficeVisibility(
  runtime: RunnerCacheControl | undefined,
  office: Office,
  visibility: "private" | null,
): SettingsApplyResult {
  if (runtime && !runtime.refreshConversationEnvironment(office.address)) {
    return { ok: false, reason: "busy" };
  }
  setOfficeVisibilityOverride(office, visibility);
  return { ok: true, runtimeSwitched: runtime ? true : null };
}
