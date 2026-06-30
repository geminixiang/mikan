/**
 * Settings and configuration for mikan.
 *
 * This module re-exports from the harness settings-manager for backward compatibility.
 * All implementation lives in src/harness/settings-manager.ts.
 */
export type { AgentConfig, AutoReplyConfig } from "./types.js";
export {
  MissingGlobalSettingsError,
  createGlobalSettingsFile,
  loadGlobalSettings,
  loadAutoReplyJudgeModel,
  loadConversationAutoReplyConfig,
  resolveConversationSettings,
  resolveLinkBaseUrl,
  resolveStateDirFromArgv,
  resolveSentryDsn,
  resolveWorkspaceDirFromArgv,
  saveConversationAutoReplyConfig,
  updateGlobalSettings,
  updateConversationSettings,
} from "./harness/settings-manager.js";
