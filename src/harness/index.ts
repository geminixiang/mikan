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
export { MikanModels, defaultModelsJsonPath } from "./models.js";
export type { CreateMikanModelsOptions } from "./types.js";
export { SessionStore, loadSessionFileEntries, parseSessionFileEntries } from "./session-store.js";
export {
  MikanAgentSession,
} from "./runner.js";
export type {
  CompactionReason,
  HarnessEvent,
  HarnessEventListener,
  MikanAgentSessionOptions,
  PromptBlockedOutcome,
} from "./types.js";
export {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  parseFrontmatter,
} from "./skills.js";
export type { LoadSkillsResult, MikanSkill, SkillDiagnostic } from "./types.js";
export {
  loadSubagentProfiles,
} from "./subagent-profiles.js";
export type { LoadSubagentProfilesResult, SubagentProfileDiagnostic } from "./types.js";
export {
  DEFAULT_BUDGET_SETTINGS,
  DEFAULT_EVENT_BUDGET,
  DEFAULT_RETRY_SETTINGS,
  resolveHarnessSettings,
  type CompactionSettings,
} from "./settings.js";
export type { BudgetSettings, HarnessSettings, RetrySettings } from "./types.js";
export {
  buildEventPayload,
  EventTypeSchema,
  parseEventPayload,
} from "./event-format.js";
export type {
  EventConversationKind,
  EventFilePayload,
  EventPayloadInput,
  EventType,
  ImmediateEventPayload,
  OneShotEventPayload,
  PeriodicEventPayload,
} from "./types.js";
export { ExtensionRegistry, parseCommandInput } from "./extensions/registry.js";
export { EXT_ACTION_PREFIX, namespaceActionIds, parseExtActionId } from "./extensions/blockkit.js";
export {
  defaultExtensionDirs,
  extensionSlug,
  listInstalledExtensions,
  loadExtensions,
  validateExtension,
} from "./extensions/loader.js";
export type {
  ExtensionValidation,
  InstalledExtensionInfo,
  LoadExtensionsOptions,
  LoadExtensionsResult,
} from "./extensions/types.js";
export type {
  AgentErrorHookEvent,
  BeforeAgentStartHookEvent,
  BeforeAgentStartHookResult,
  BudgetExceededHookEvent,
  ContextHookEvent,
  ContextHookResult,
  SubagentApi,
  ExtensionBlockAction,
  ExtensionBlockActionHandler,
  ExtensionBlockKitMessage,
  ExtensionCommand,
  ExtensionCommandContext,
  ExtensionDisposer,
  ExtensionHostServices,
  ExtensionLoadError,
  ExtensionManifest,
  ExtensionScheduleInfo,
  ExtensionSchedulePayload,
  ExtensionScheduleSpec,
  ExtensionScheduleStore,
  LoadedExtension,
  MessageEndHookEvent,
  MessageEndHookResult,
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
  type SubagentModelSpec,
  type SubagentProfile,
  type SubagentParentContext,
  type SubagentRunBudget,
  type SubagentRunOutput,
  type SubagentRunRequest,
  type SubagentRunResult,
  type SubagentRunStatus,
  type SubagentUsage,
  type SubagentUsageSink,
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
