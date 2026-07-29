import type { OfficeAddress, OfficeKey } from "../types.js";

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
   * Host-only state root (settings, credentials, extension code/data).
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
