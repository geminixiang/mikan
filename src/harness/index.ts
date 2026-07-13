/**
 * mikan agent harness.
 *
 * mikan's own harness engineering layer, built directly on pi-agent-core
 * (agent loop, compaction, context building) and pi-ai (providers, models,
 * auth). See `src/harness/README.md` for the architecture.
 */
export { FileCredentialStore, defaultAuthPath } from "./auth.js";
export {
  DEFAULT_HTTP_IDLE_TIMEOUT_MS,
  configureHttpDispatcher,
  parseHttpIdleTimeoutMs,
} from "./http.js";
export { MikanModels, defaultModelsJsonPath, type CreateMikanModelsOptions } from "./models.js";
export { SessionStore, loadSessionFileEntries, parseSessionFileEntries } from "./session-store.js";
export {
  MikanAgentSession,
  type CompactionReason,
  type HarnessEvent,
  type HarnessEventListener,
  type MikanAgentSessionOptions,
  type PromptBlockedOutcome,
} from "./runner.js";
export {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  parseFrontmatter,
  type LoadSkillsResult,
  type MikanSkill,
  type SkillDiagnostic,
} from "./skills.js";
export {
  DEFAULT_BUDGET_SETTINGS,
  DEFAULT_EVENT_BUDGET,
  DEFAULT_RETRY_SETTINGS,
  resolveHarnessSettings,
  type BudgetSettings,
  type CompactionSettings,
  type HarnessSettings,
  type RetrySettings,
} from "./settings.js";
export { ExtensionRegistry } from "./extensions/registry.js";
export {
  defaultExtensionDirs,
  extensionSlug,
  listInstalledExtensions,
  loadExtensions,
  validateExtension,
  type ExtensionValidation,
  type InstalledExtensionInfo,
  type LoadExtensionsOptions,
  type LoadExtensionsResult,
} from "./extensions/loader.js";
export type {
  BeforeAgentStartHookEvent,
  BeforeAgentStartHookResult,
  ExtensionHostServices,
  ExtensionLoadError,
  ExtensionManifest,
  ExtensionScheduleInfo,
  ExtensionSchedulePayload,
  ExtensionScheduleSpec,
  ExtensionScheduleStore,
  LoadedExtension,
  MessageEndHookEvent,
  MikanExtensionActivate,
  MikanExtensionApi,
  MikanExtensionModule,
  MikanHookMap,
  MikanHookName,
  RunOrigin,
  SessionCompactHookEvent,
  ToolCallHookEvent,
  ToolCallHookResult,
  ToolResultHookEvent,
  ToolResultHookResult,
  TurnEndHookEvent,
} from "./extensions/types.js";
export {
  CURRENT_SESSION_VERSION,
  type BranchSummaryEntry,
  type CompactionEntry,
  type CustomEntry,
  type CustomMessageEntry,
  type SessionContext,
  type SessionEntry,
  type SessionFileEntry,
  type SessionHeader,
  type SessionInfoEntry,
  type SessionMessageEntry,
} from "./types.js";
