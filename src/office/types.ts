import type {
  ContainerMount,
  OfficeAddress,
  OfficeKey,
  WorkspaceDoorPolicy,
  WorkspaceLayout,
  WorkspaceVisibility,
} from "../types.js";

export interface OfficeMigrationRunSummary {
  /** Raw ids whose directories moved to the office-key layout this run. */
  migrated: string[];
  /** Raw ids whose interrupted moves were completed from the journal. */
  recovered: string[];
  /** Raw ids that still need an explicit owner (`mikan office claim`). */
  unowned: string[];
  /** Raw ids whose records are failed and need operator repair. */
  failed: string[];
  /** Raw ids whose conversation vault directories moved to office keys. */
  vaultKeysMigrated: string[];
  /** Raw ids whose legacy and office-key vault dirs both exist (manual merge). */
  vaultConflicts: string[];
  /** Raw ids whose host state directories moved. */
  stateDirsMigrated: string[];
  /** Raw ids whose legacy and office-key state dirs both exist (manual merge). */
  stateDirConflicts: string[];
}

/**
 * One mikan deployment's agent world on the host: the workspace root, the
 * workspace-global surfaces, and the factory for per-conversation offices.
 * Constructed once per process (`createWorkspace`); everything downstream
 * receives the value instead of re-deriving paths from root strings.
 */
export interface Workspace {
  /** Host workspace root directory. */
  readonly root: string;
  /**
   * Host-only state root (settings, credentials, and office records).
   * Not part of the Workspace projection; carried here so offices can
   * derive their state dirs and the registry knows where its journal lives.
   */
  readonly stateDir: string;
  /** Workspace-global memory file: `<root>/MEMORY.md`. */
  readonly memoryPath: string;
  /** Workspace-global skills directory: `<root>/skills`. */
  readonly skillsDir: string;
  /** The workspace scheduling bus: `<root>/events` (global by design). */
  readonly eventsDir: string;
  /** Subagent profile patches: `<root>/agents`. */
  readonly agentsDir: string;
  /** Workspace-root entries that are shared infrastructure, never office dirs. */
  readonly reservedNames: ReadonlySet<string>;
  /**
   * The Conversation office for an address. Values are memoized per address,
   * so repeated calls on hot paths cost one map lookup, not a hash.
   */
  office(address: OfficeAddress): Office;
}

/**
 * One Conversation office: canonical identity plus the office's host-side
 * directory layout. A frozen value — every field is precomputed at
 * construction. Fields exist only for paths that more than one module needs;
 * single-consumer subpaths stay `join(office.dir, …)` at their call site.
 */
export interface Office {
  /** Canonical identity: platform plus raw platform conversation id. */
  readonly address: OfficeAddress;
  /**
   * The office key — the collision-resistant directory segment, identical on
   * the host and inside sandbox runtimes, and the conversation vault key.
   */
  readonly key: OfficeKey;
  /** The office working directory: `<workspace root>/<key>`. */
  readonly dir: string;
  /** Conversation memory file: `<dir>/MEMORY.md`. */
  readonly memoryPath: string;
  /** Conversation skills directory: `<dir>/skills`. */
  readonly skillsDir: string;
  /** Persisted chat-session files: `<dir>/sessions`. */
  readonly sessionsDir: string;
  /** Downloaded message attachments: `<dir>/attachments`. */
  readonly attachmentsDir: string;
  /** Human-readable message history: `<dir>/log.jsonl`. */
  readonly logPath: string;
  /** Host-only per-office state: `<state dir>/conversations/<key>`. */
  readonly stateDir: string;
  /** The workspace this office belongs to. */
  readonly workspace: Workspace;
  /**
   * Materialize the office working directory: record the office in the
   * registry, then create the directory. Idempotent and safe on hot
   * per-message paths — recording is cached, the mkdir is a guarded check.
   * Returns `dir`.
   */
  ensure(): string;
}

/**
 * The conversation's platform-native channel kind, using the platform's own
 * vocabulary (Slack conversation types), not a mikan-invented one. Recorded
 * at message intake and used to derive the workspace projection when no
 * explicit workspace setting exists: public channels share workspace memory
 * read-write, private channels read it without writing back, DMs and
 * externally shared channels stay isolated.
 */
export type PlatformChannelKind = "public_channel" | "private_channel" | "im" | "external";

interface WorkspacePromptSources {
  conversationDir: string;
  conversationMemoryPath: string;
  conversationSkillsDir: string;
  globalMemoryPath?: string;
  globalSkillsDir?: string;
  /** True when globalMemoryPath is mounted read-only (shared-support + private visibility). */
  globalMemoryReadOnly?: boolean;
}

export interface WorkspaceProjection {
  doorPolicy: WorkspaceDoorPolicy;
  layout: WorkspaceLayout;
  /** Only meaningful for shared-support layout; "public" is the default and preserves prior read-write behavior. */
  visibility: WorkspaceVisibility;
  mounts: ContainerMount[];
  promptSources: WorkspacePromptSources;
}
