/**
 * The Conversation office module: canonical identity, the Workspace/Office
 * layout values, the durable registry journal, and the boot-time legacy
 * migration. Everything outside `src/office/` imports from this module;
 * exported types live in `types.ts` per module convention.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import * as log from "../log.js";
import type {
  OfficeAddress,
  OfficeKey,
  OfficeMigrationPreparation,
  OfficeMigrationRecord,
  OfficeMigrationStatus,
  OfficeRecord,
  OfficeRegistryState,
  PlatformName,
} from "../types.js";
import type { Office, Workspace } from "./types.js";
export type { Office, Workspace } from "./types.js";
import { parseGithubConversationId } from "../adapters/github/ids.js";
import { legacyConversationCredentialKey } from "../sandbox/identity.js";
import { migrateConversationVaultKeys } from "../vault/index.js";
import { atomicWritePrivateFile, isRecord, readTextFileIfExists } from "../utils/file-guards.js";

// ── Office identity (address & keys) ──────────────────────────────────────────

const OFFICE_KEY_VERSION = "v1";
const OFFICE_KEY_DOMAIN = "office-address-v1";
const OFFICE_KEY_DIGEST_LENGTH = 16;
const READABLE_ID_LENGTH = 32;
const PLATFORM_NAMES = new Set<PlatformName>(["slack", "discord", "telegram", "github"]);
const OFFICE_KEY_PATTERN =
  /^v1-(slack|discord|telegram|github)-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{16}$/;

/** Construct the canonical identity used by future office consumers. */
export function createOfficeAddress(platform: PlatformName, conversationId: string): OfficeAddress {
  assertPlatformName(platform);
  assertConversationId(conversationId);
  return Object.freeze({ platform, conversationId });
}

/** Validate an untrusted runtime value as a canonical office address. */
export function validateOfficeAddress(value: unknown): OfficeAddress {
  if (!isRecord(value)) throw new Error("Office address must be an object");
  if (typeof value.platform !== "string") {
    throw new Error("Office address platform must be a string");
  }
  if (typeof value.conversationId !== "string") {
    throw new Error("Office address conversation id must be a string");
  }
  return createOfficeAddress(assertPlatformName(value.platform), value.conversationId);
}

/** Return true only for a supported platform name. */
function isPlatformName(value: unknown): value is PlatformName {
  return typeof value === "string" && PLATFORM_NAMES.has(value as PlatformName);
}

/** Validate a platform name and return it for typed callers. */
export function assertPlatformName(value: string): PlatformName {
  if (!isPlatformName(value)) throw new Error(`Unsupported platform: ${JSON.stringify(value)}`);
  return value;
}

/** Validate a raw platform conversation identifier before it enters storage. */
export function assertConversationId(value: string): string {
  if (value.length === 0 || value === "." || value === "..") {
    throw new Error("Conversation id must be non-empty and not a path marker");
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      character === "/" ||
      character === "\\" ||
      code === 0 ||
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      throw new Error("Conversation id must not contain path separators or control characters");
    }
  }
  return value;
}

/** Derive a readable diagnostic key whose digest remains the identity authority. */
export function officeKey(address: OfficeAddress): OfficeKey {
  const normalized = validateOfficeAddress(address);
  const readable = readableConversationId(normalized.conversationId);
  const digest = createHash("sha256")
    .update(`${OFFICE_KEY_DOMAIN}\0${normalized.platform}\0${normalized.conversationId}`)
    .digest("hex")
    .slice(0, OFFICE_KEY_DIGEST_LENGTH);
  return `${OFFICE_KEY_VERSION}-${normalized.platform}-${readable}-${digest}` as OfficeKey;
}

/**
 * Resolve the persistent workspace directory for an office.
 * Module-internal: registry/migration record target paths with it. Callers
 * outside `src/office/` use the `Office` value's `dir` field instead.
 */
export function officeDir(workspaceRoot: string, address: OfficeAddress): string {
  return join(workspaceRoot, officeKey(address));
}

/**
 * Resolve the host-only state directory for an office.
 *
 * Transitional: settings/packages/extension callers that only hold a
 * `stateDir` string keep using this until their option bags carry an
 * `Office` value (which exposes the same path as `stateDir`).
 */
export function officeStateDir(stateDir: string, address: OfficeAddress): string {
  return join(stateDir, "conversations", officeKey(address));
}

/** Compare canonical office identities without relying on their readable key. */
export function sameOffice(left: OfficeAddress, right: OfficeAddress): boolean {
  const leftAddress = validateOfficeAddress(left);
  const rightAddress = validateOfficeAddress(right);
  return (
    leftAddress.platform === rightAddress.platform &&
    leftAddress.conversationId === rightAddress.conversationId
  );
}

/** Validate a persisted or externally supplied office key. */
export function assertOfficeKey(value: string): OfficeKey {
  if (!OFFICE_KEY_PATTERN.test(value)) {
    throw new Error(`Invalid office key: ${JSON.stringify(value)}`);
  }
  return value as OfficeKey;
}

export function isOfficeKey(value: unknown): value is OfficeKey {
  return typeof value === "string" && OFFICE_KEY_PATTERN.test(value);
}

function readableConversationId(conversationId: string): string {
  const readable = conversationId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, READABLE_ID_LENGTH)
    .replace(/-+$/g, "");
  return readable || "conversation";
}

// ── Workspace/Office layout ───────────────────────────────────────────────────
/**
 * Workspace-root entries that are shared infrastructure, never office dirs.
 * The single definition behind boot-time directory setup, the events
 * watcher, the workspace projection, and the migration's legacy-dir scan.
 */
export const RESERVED_WORKSPACE_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(["skills", "events", "agents", "MEMORY.md"]),
);

/**
 * Construct the Workspace value for a deployment. One construction site per
 * process (main.ts for the daemon; CLI subcommands and tests build their
 * own). The value owns the registry instance and the recorded-office cache
 * that office materialization uses on hot paths, so there is no process-wide
 * registry state.
 */
/**
 * An office's session files live in `<office dir>/sessions` — the one home of
 * that rule. String-based for surfaces that hold a conversation dir rather
 * than an `Office` value (mirrors `officeStateDir`); `Office.sessionsDir` is
 * derived from it. Pointer/thread-file semantics live in `sessions/store`.
 */
export function officeSessionsDir(dir: string): string {
  return join(dir, "sessions");
}

export function createWorkspace(options: { root: string; stateDir: string }): Workspace {
  // Paths are joined as given (no resolve) so values match what callers
  // passing the same root/stateDir strings computed before this module.
  const { root, stateDir } = options;
  // Lazy: CLI surfaces construct a Workspace for path math without paying
  // for (or being allowed to create) the registry journal.
  let registry: OfficeRegistry | undefined;
  const recorded = new Set<string>();
  const offices = new Map<string, Office>();

  const workspace: Workspace = Object.freeze({
    root,
    stateDir,
    memoryPath: join(root, "MEMORY.md"),
    skillsDir: join(root, "skills"),
    eventsDir: join(root, "events"),
    agentsDir: join(root, "agents"),
    reservedNames: RESERVED_WORKSPACE_NAMES,
    office(address: OfficeAddress): Office {
      const normalized = validateOfficeAddress(address);
      const key = officeKey(normalized);
      const existing = offices.get(key);
      if (existing) return existing;

      const dir = join(root, key);
      const office: Office = Object.freeze({
        address: normalized,
        key,
        dir,
        memoryPath: join(dir, "MEMORY.md"),
        skillsDir: join(dir, "skills"),
        sessionsDir: officeSessionsDir(dir),
        attachmentsDir: join(dir, "attachments"),
        logPath: join(dir, "log.jsonl"),
        stateDir: join(stateDir, "conversations", key),
        workspace,
        ensure(): string {
          // Record-first ordering: a crash can leave a record without a
          // directory (harmless; recreated on the next message) but never an
          // anonymous office directory the registry cannot enumerate.
          if (!recorded.has(key)) {
            registry ??= new OfficeRegistry(stateDir);
            registry.recordOffice(normalized);
            recorded.add(key);
          }
          ensureRegularOfficeDirectory(dir);
          return dir;
        },
      });
      offices.set(key, office);
      return office;
    },
  });
  return workspace;
}

/** mkdir-if-missing with the same fail-closed type guard as projection roots. */
function ensureRegularOfficeDirectory(dir: string): void {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Office directory must be a regular non-symlink directory: ${dir}`);
  }
}

// ── Office registry journal ───────────────────────────────────────────────────
const REGISTRY_VERSION = 1;
const REGISTRY_FILENAME = "office-registry.json";
const MIGRATION_STATUSES = new Set<OfficeMigrationStatus>([
  "needs-owner",
  "prepared",
  "moving",
  "committed",
  "failed",
]);
const REGISTRY_LOCK_FILENAME = ".office-registry.lock";
const REGISTRY_LOCK_RETRY_MS = 25;
const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const REGISTRY_LOCK_STALE_MS = 60_000;

/**
 * Host-only office directory and migration journal.
 *
 * Office records are the durable raw-id ↔ (platform, office) mapping: the
 * ADR 0005 layout migration renamed workspace dirs to office keys, so dir
 * names carry no raw platform ids and enumeration/legacy-scope lookups
 * resolve through these records. Migration records track claiming legacy
 * raw-id directories. Office materialization lives in `layout.ts`; this
 * module owns only the durable record and its crash-safe transitions.
 */
interface OfficeRegistryOptions {
  writeState?: (path: string, content: string) => void;
  lockTimeoutMs?: number;
}

export class OfficeRegistry {
  private readonly stateDir: string;
  private readonly registryPath: string;
  private readonly lockPath: string;
  private readonly writeState: (path: string, content: string) => void;
  private readonly lockTimeoutMs: number;
  private state: OfficeRegistryState;

  constructor(stateDir: string, options: OfficeRegistryOptions = {}) {
    this.stateDir = resolve(stateDir);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    assertRegularDirectory(this.stateDir, "State directory");
    this.registryPath = resolve(this.stateDir, REGISTRY_FILENAME);
    this.lockPath = join(this.stateDir, REGISTRY_LOCK_FILENAME);
    this.writeState = options.writeState ?? atomicWritePrivateFile;
    this.lockTimeoutMs = options.lockTimeoutMs ?? REGISTRY_LOCK_TIMEOUT_MS;
    this.state = this.readState();
  }

  /** Reload the atomic registry file after another host process changed it. */
  reload(): OfficeRegistryState {
    this.state = this.readState();
    return this.state;
  }

  getState(): OfficeRegistryState {
    return this.state;
  }

  getMigration(rawConversationId: string): OfficeMigrationRecord | undefined {
    assertConversationId(rawConversationId);
    return this.state.migrations.find((record) => record.rawConversationId === rawConversationId);
  }

  enablePlatform(platform: PlatformName): OfficeRegistryState {
    const validPlatform = assertPlatformName(platform);
    return this.withExclusiveLease(() => {
      if (this.state.enabledPlatforms.includes(validPlatform)) return this.state;

      const enabledPlatforms = [...this.state.enabledPlatforms, validPlatform].toSorted();
      this.replaceState(enabledPlatforms, this.state.offices, this.state.migrations);
      return this.state;
    });
  }

  /**
   * Record that an office exists. Idempotent: re-recording a known office is
   * a lock-free cache hit for callers that materialize directories per
   * message, so this sits safely on hot write paths.
   */
  recordOffice(address: OfficeAddress): OfficeRecord {
    const normalized = validateOfficeAddress(address);
    const existing = this.findOffice(normalized);
    if (existing) return existing;
    return this.withExclusiveLease(() => {
      const found = this.findOffice(normalized);
      if (found) return found;
      const record: OfficeRecord = Object.freeze({
        platform: normalized.platform,
        conversationId: normalized.conversationId,
        recordedAt: new Date().toISOString(),
      });
      this.replaceState(
        this.state.enabledPlatforms,
        [...this.state.offices, record],
        this.state.migrations,
      );
      return record;
    });
  }

  getOffices(): readonly OfficeRecord[] {
    return this.state.offices;
  }

  private findOffice(address: OfficeAddress): OfficeRecord | undefined {
    return this.state.offices.find(
      (record) =>
        record.platform === address.platform && record.conversationId === address.conversationId,
    );
  }

  /**
   * Validate and record a legacy directory. With exactly one enabled platform,
   * ownership is safe to infer. With zero or multiple platforms, the record
   * remains explicit `needs-owner` unless the caller supplies an owner.
   */
  prepareLegacyMigration(options: OfficeMigrationPreparation): OfficeMigrationRecord {
    const rawConversationId = assertConversationId(options.rawConversationId);
    const sourceDir = resolve(options.sourceDir);
    const workspaceRoot = resolve(options.workspaceRoot);
    return this.withExclusiveLease(() => {
      const existing = this.getMigration(rawConversationId);
      assertCanonicalSource(sourceDir, workspaceRoot, rawConversationId);
      if (existing) {
        assertSameMigrationInputs(existing, sourceDir, workspaceRoot);
        if (existing.status !== "needs-owner") return existing;
      }

      assertRegularDirectory(sourceDir, "Legacy office source");
      const ownerPlatform = this.resolveOwner(options.ownerPlatform, rawConversationId);
      if (!ownerPlatform) {
        const record = makeRecord({
          rawConversationId,
          sourceDir,
          workspaceRoot,
          status: "needs-owner",
        });
        this.replaceMigration(existing, record);
        return record;
      }

      const targetDir = officeDir(workspaceRoot, {
        platform: ownerPlatform,
        conversationId: rawConversationId,
      });
      if (pathExists(targetDir)) {
        const failed = makeRecord({
          rawConversationId,
          sourceDir,
          workspaceRoot,
          ownerPlatform,
          targetDir,
          status: "failed",
          error: "Target office directory already exists",
        });
        this.replaceMigration(existing, failed);
        throw new Error(`${failed.error}: ${targetDir}`);
      }

      const prepared = makeRecord({
        rawConversationId,
        sourceDir,
        workspaceRoot,
        ownerPlatform,
        targetDir,
        status: "prepared",
      });
      this.replaceMigration(existing, prepared);
      return prepared;
    });
  }

  markMoving(rawConversationId: string): OfficeMigrationRecord {
    return this.withExclusiveLease(() => {
      const record = this.requireMigration(rawConversationId);
      if (
        record.status === "moving" ||
        record.status === "committed" ||
        record.status === "failed"
      ) {
        return record;
      }
      if (record.status === "needs-owner") {
        throw new Error(`Legacy office ${JSON.stringify(rawConversationId)} still needs an owner`);
      }
      assertRegularDirectory(record.sourceDir, "Legacy office source");
      const targetDir = migrationTarget(record);
      if (!targetDir) throw new Error("Prepared office migration has no target directory");
      if (pathExists(targetDir)) {
        const failed = this.failRecord(record, "Target office directory appeared before moving");
        throw new Error(`${failed.error}: ${targetDir}`);
      }

      const moving = transitionRecord(record, "moving");
      this.replaceMigration(record, moving);
      return moving;
    });
  }

  markCommitted(rawConversationId: string): OfficeMigrationRecord {
    return this.withExclusiveLease(() => {
      const record = this.requireMigration(rawConversationId);
      if (record.status === "committed" || record.status === "failed") return record;
      if (record.status !== "moving") {
        throw new Error(`Cannot commit office migration from ${record.status}`);
      }
      const targetDir = migrationTarget(record);
      if (!targetDir) throw new Error("Moving office migration has no target directory");
      assertRegularDirectory(targetDir, "Migrated office target");
      assertPathAbsent(record.sourceDir, "Legacy office source");

      const committed = transitionRecord(record, "committed");
      this.replaceMigration(record, committed);
      return committed;
    });
  }

  markFailed(rawConversationId: string, error: string): OfficeMigrationRecord {
    return this.withExclusiveLease(() => {
      const record = this.requireMigration(rawConversationId);
      if (record.status === "committed") {
        throw new Error("A committed office migration cannot be marked failed");
      }
      if (record.status === "failed") return record;
      return this.failRecord(record, error);
    });
  }

  private resolveOwner(
    ownerPlatform: PlatformName | undefined,
    rawConversationId: string,
  ): PlatformName | undefined {
    if (ownerPlatform !== undefined) {
      const validPlatform = assertPlatformName(ownerPlatform);
      if (!this.state.enabledPlatforms.includes(validPlatform)) {
        throw new Error(`Owner platform ${validPlatform} is not enabled`);
      }
      return validPlatform;
    }
    const candidates = platformsMatchingConversationIdFormat(
      rawConversationId,
      this.state.enabledPlatforms,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private requireMigration(rawConversationId: string): OfficeMigrationRecord {
    assertConversationId(rawConversationId);
    const record = this.getMigration(rawConversationId);
    if (!record) throw new Error(`No office migration registered for ${rawConversationId}`);
    return record;
  }

  private failRecord(record: OfficeMigrationRecord, error: string): OfficeMigrationRecord {
    const message = error.trim();
    if (!message) throw new Error("Office migration failure reason must not be empty");
    const failed = transitionRecord(record, "failed", message);
    this.replaceMigration(record, failed);
    return failed;
  }

  private replaceMigration(
    previous: OfficeMigrationRecord | undefined,
    next: OfficeMigrationRecord,
  ): void {
    const migrations = [...this.state.migrations];
    const index = previous
      ? migrations.findIndex((record) => record.rawConversationId === previous.rawConversationId)
      : -1;
    if (index === -1) migrations.push(next);
    else migrations[index] = next;
    this.replaceState(this.state.enabledPlatforms, this.state.offices, migrations);
  }

  private replaceState(
    enabledPlatforms: readonly PlatformName[],
    offices: readonly OfficeRecord[],
    migrations: readonly OfficeMigrationRecord[],
  ): void {
    const candidate = freezeState({ enabledPlatforms, offices, migrations });
    this.writeState(this.registryPath, `${JSON.stringify(candidate, null, 2)}\n`);
    this.state = candidate;
  }

  /**
   * Acquire the domain lease, reload while holding it, then perform one
   * read-modify-write. A future move transaction can retain the same lease
   * across its filesystem operation instead of splitting the transition.
   */
  private withExclusiveLease<T>(operation: () => T): T {
    const release = acquireRegistryLease(this.lockPath, this.lockTimeoutMs);
    try {
      this.state = this.readState();
      return operation();
    } finally {
      release();
    }
  }

  private readState(): OfficeRegistryState {
    assertRegistryFileSafe(this.registryPath);
    const raw = readTextFileIfExists(this.registryPath);
    if (raw === undefined) {
      return freezeState({ enabledPlatforms: [], offices: [], migrations: [] });
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid office registry JSON at ${this.registryPath}`, { cause: error });
    }
    return parseState(value, this.registryPath);
  }
}

interface RecordFields {
  rawConversationId: string;
  sourceDir: string;
  workspaceRoot: string;
  ownerPlatform?: PlatformName;
  targetDir?: string;
  status: OfficeMigrationStatus;
  error?: string;
  updatedAt?: string;
}

function makeRecord(fields: RecordFields): OfficeMigrationRecord {
  const record: OfficeMigrationRecord = {
    rawConversationId: fields.rawConversationId,
    sourceDir: fields.sourceDir,
    workspaceRoot: fields.workspaceRoot,
    ...(fields.ownerPlatform ? { ownerPlatform: fields.ownerPlatform } : {}),
    ...(fields.targetDir ? { targetDir: fields.targetDir } : {}),
    status: fields.status,
    ...(fields.error ? { error: fields.error } : {}),
    updatedAt: fields.updatedAt ?? new Date().toISOString(),
  };
  return Object.freeze(record);
}

function transitionRecord(
  record: OfficeMigrationRecord,
  status: OfficeMigrationStatus,
  error?: string,
): OfficeMigrationRecord {
  const targetDir = migrationTarget(record);
  return makeRecord({
    rawConversationId: record.rawConversationId,
    sourceDir: record.sourceDir,
    workspaceRoot: record.workspaceRoot,
    ...(record.ownerPlatform ? { ownerPlatform: record.ownerPlatform } : {}),
    ...(targetDir ? { targetDir } : {}),
    status,
    ...(error ? { error } : {}),
  });
}

function migrationTarget(record: OfficeMigrationRecord): string | undefined {
  return record.ownerPlatform
    ? officeDir(record.workspaceRoot, {
        platform: record.ownerPlatform,
        conversationId: record.rawConversationId,
      })
    : undefined;
}

function freezeState(input: {
  enabledPlatforms: readonly PlatformName[];
  offices: readonly OfficeRecord[];
  migrations: readonly OfficeMigrationRecord[];
}): OfficeRegistryState {
  return Object.freeze({
    version: REGISTRY_VERSION as 1,
    enabledPlatforms: Object.freeze([...input.enabledPlatforms]),
    offices: Object.freeze(input.offices.map((record) => Object.freeze({ ...record }))),
    migrations: Object.freeze(input.migrations.map((record) => Object.freeze({ ...record }))),
  });
}

function parseState(value: unknown, path: string): OfficeRegistryState {
  if (!isRecord(value) || value.version !== REGISTRY_VERSION) {
    throw new Error(`Invalid office registry version at ${path}`);
  }
  if (!Array.isArray(value.enabledPlatforms) || !Array.isArray(value.migrations)) {
    throw new Error(`Invalid office registry shape at ${path}`);
  }

  const enabledPlatforms = value.enabledPlatforms.map((platform) => {
    if (typeof platform !== "string") throw new Error(`Invalid enabled platform in ${path}`);
    return assertPlatformName(platform);
  });
  if (new Set(enabledPlatforms).size !== enabledPlatforms.length) {
    throw new Error(`Duplicate enabled platform in ${path}`);
  }

  // Files written before office records existed simply have no offices yet.
  const offices = (Array.isArray(value.offices) ? value.offices : []).map((entry) =>
    parseOfficeRecord(entry, path),
  );
  if (new Set(offices.map((record) => officeKey(record))).size !== offices.length) {
    throw new Error(`Duplicate office record in ${path}`);
  }

  const migrations = value.migrations.map((entry) => parseRecord(entry, path, enabledPlatforms));
  if (new Set(migrations.map((record) => record.rawConversationId)).size !== migrations.length) {
    throw new Error(`Duplicate office migration in ${path}`);
  }
  return freezeState({ enabledPlatforms, offices, migrations });
}

function parseOfficeRecord(value: unknown, path: string): OfficeRecord {
  if (!isRecord(value)) throw new Error(`Invalid office record in ${path}`);
  if (
    typeof value.platform !== "string" ||
    typeof value.conversationId !== "string" ||
    typeof value.recordedAt !== "string"
  ) {
    throw new Error(`Invalid office record fields in ${path}`);
  }
  return Object.freeze({
    platform: assertPlatformName(value.platform),
    conversationId: assertConversationId(value.conversationId),
    recordedAt: value.recordedAt,
  });
}

function parseRecord(
  value: unknown,
  path: string,
  enabledPlatforms: readonly PlatformName[],
): OfficeMigrationRecord {
  if (!isRecord(value)) throw new Error(`Invalid office migration record in ${path}`);
  if (
    typeof value.rawConversationId !== "string" ||
    typeof value.sourceDir !== "string" ||
    typeof value.workspaceRoot !== "string" ||
    typeof value.status !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error(`Invalid office migration fields in ${path}`);
  }
  assertConversationId(value.rawConversationId);
  if (!isAbsolute(value.sourceDir) || !isAbsolute(value.workspaceRoot)) {
    throw new Error(`Office migration paths must be absolute in ${path}`);
  }
  assertCanonicalSource(value.sourceDir, value.workspaceRoot, value.rawConversationId);
  if (!MIGRATION_STATUSES.has(value.status as OfficeMigrationStatus)) {
    throw new Error(`Invalid office migration status in ${path}`);
  }

  const ownerPlatform = optionalPlatform(value.ownerPlatform);
  const targetDir = optionalString(value.targetDir);
  const error = optionalString(value.error);
  if (ownerPlatform !== undefined && !enabledPlatforms.includes(ownerPlatform)) {
    throw new Error(`Office migration owner is not enabled in ${path}`);
  }
  if (value.status === "needs-owner" && (ownerPlatform !== undefined || targetDir !== undefined)) {
    throw new Error(`Needs-owner migration cannot have an owner or target in ${path}`);
  }
  if (
    value.status !== "needs-owner" &&
    value.status !== "failed" &&
    (ownerPlatform === undefined || targetDir === undefined)
  ) {
    throw new Error(`Prepared office migration is missing ownership in ${path}`);
  }
  if (ownerPlatform === undefined && targetDir !== undefined) {
    throw new Error(`Office migration target has no owner in ${path}`);
  }
  const expectedTargetDir = ownerPlatform
    ? officeDir(value.workspaceRoot, {
        platform: ownerPlatform,
        conversationId: value.rawConversationId,
      })
    : undefined;
  if (targetDir !== expectedTargetDir) {
    throw new Error(`Office migration target does not match its office address in ${path}`);
  }
  if (value.status === "failed" && !error) {
    throw new Error(`Failed office migration is missing an error in ${path}`);
  }

  return makeRecord({
    rawConversationId: value.rawConversationId,
    sourceDir: value.sourceDir,
    workspaceRoot: value.workspaceRoot,
    ...(ownerPlatform ? { ownerPlatform } : {}),
    ...(expectedTargetDir ? { targetDir: expectedTargetDir } : {}),
    status: value.status as OfficeMigrationStatus,
    ...(error ? { error } : {}),
    updatedAt: value.updatedAt,
  });
}

function optionalPlatform(value: unknown): PlatformName | undefined {
  return value === undefined
    ? undefined
    : typeof value === "string"
      ? assertPlatformName(value)
      : failOptional("platform");
}

function optionalString(value: unknown): string | undefined {
  return value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : failOptional("string");
}

function failOptional(label: string): never {
  throw new Error(`Invalid optional ${label} in office registry`);
}

function assertSameMigrationInputs(
  existing: OfficeMigrationRecord,
  sourceDir: string,
  workspaceRoot: string,
): void {
  if (existing.sourceDir !== sourceDir || existing.workspaceRoot !== workspaceRoot) {
    throw new Error(`Legacy office migration inputs changed for ${existing.rawConversationId}`);
  }
}

function assertCanonicalSource(
  sourceDir: string,
  workspaceRoot: string,
  rawConversationId: string,
): void {
  const expectedSourceDir = resolve(workspaceRoot, rawConversationId);
  if (sourceDir !== expectedSourceDir) {
    throw new Error(`Legacy office source must be ${expectedSourceDir}`);
  }
  assertRegularDirectory(workspaceRoot, "Workspace root");
  assertPathIfPresent(sourceDir, "Legacy office source");
}

function assertRegularDirectory(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} does not exist: ${path}`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a regular directory: ${path}`);
  }
}

function assertRegistryFileSafe(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Office registry must be a regular file: ${path}`);
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
}

function assertPathIfPresent(path: string, label: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} must be a regular directory: ${path}`);
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
}

function assertPathAbsent(path: string, label: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
  throw new Error(`${label} must be absent: ${path}`);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function acquireRegistryLease(lockPath: string, timeoutMs: number): () => void {
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;

  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(join(lockPath, "owner"), `${token}\n`, { mode: 0o600 });
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return () => releaseRegistryLease(lockPath, token);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      if (registryLockIsStale(lockPath)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring office registry lock: ${lockPath}`, { cause: error });
      }
      sleepSync(REGISTRY_LOCK_RETRY_MS);
    }
  }
}

function releaseRegistryLease(lockPath: string, token: string): void {
  try {
    if (readFileSync(join(lockPath, "owner"), "utf8").trim() === token) {
      rmSync(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function registryLockIsStale(lockPath: string): boolean {
  let ownerKnown = false;
  let ownerAlive = false;
  try {
    const owner = readFileSync(join(lockPath, "owner"), "utf8").trim();
    const pid = Number(owner.split(":", 1)[0]);
    if (Number.isInteger(pid) && pid > 0) {
      ownerKnown = true;
      try {
        process.kill(pid, 0);
        ownerAlive = true;
      } catch (error) {
        if (isErrno(error, "EPERM")) ownerAlive = true;
      }
    }
  } catch {
    // The owner file may not have been written before its process died.
  }
  try {
    const oldEnough = Date.now() - statSync(lockPath).mtimeMs >= REGISTRY_LOCK_STALE_MS;
    return ownerKnown ? !ownerAlive : oldEnough;
  } catch {
    return false;
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// ── raw-id lookups (cold paths: CLI, Admin enumeration) ──────────────────────

/**
 * Resolve the office behind a raw conversation id for surfaces that name
 * offices by raw id (CLI operators). The registry is the only authority:
 * office records first, then a committed migration's owner, then the sole
 * enabled platform. Two platforms sharing the raw id make the scope
 * genuinely ambiguous, and an unknown id has no office to resolve — both
 * fail loudly rather than guessing a directory.
 *
 * Constructs a registry per call, which re-reads the journal from disk; this
 * is a one-shot CLI/Admin surface, never a per-message path (those go
 * through the Workspace value's cached registry in `layout.ts`).
 */
export function resolveOwnedOfficeAddress(
  rawConversationId: string,
  stateDir: string,
): OfficeAddress {
  assertConversationId(rawConversationId);
  const registry = new OfficeRegistry(stateDir);

  const matches = registry
    .getState()
    .offices.filter((record) => record.conversationId === rawConversationId);
  const single = matches.length === 1 ? matches[0] : undefined;
  if (single !== undefined) {
    return { platform: single.platform, conversationId: rawConversationId };
  }
  if (matches.length > 1) {
    throw new Error(
      `Conversation id ${JSON.stringify(rawConversationId)} names offices on several platforms; ` +
        "use a platform-scoped surface instead",
    );
  }

  const migration = registry.getMigration(rawConversationId);
  if (migration?.ownerPlatform) {
    return { platform: migration.ownerPlatform, conversationId: rawConversationId };
  }
  const { enabledPlatforms } = registry.getState();
  const onlyPlatform = enabledPlatforms.length === 1 ? enabledPlatforms[0] : undefined;
  if (onlyPlatform !== undefined) {
    return { platform: onlyPlatform, conversationId: rawConversationId };
  }
  throw new Error(
    `No office is registered for conversation id ${JSON.stringify(rawConversationId)}`,
  );
}

/** Current office inventory, read fresh from disk for cross-process freshness. */
export function listRegisteredOffices(stateDir: string): readonly OfficeRecord[] {
  return new OfficeRegistry(stateDir).getOffices();
}

/**
 * Enabled platforms whose id format could have produced this raw
 * conversation id. Auto-claiming uses this as verification, not guessing:
 * every format below is one mikan itself writes (GitHub ids are mikan-derived
 * slugs; Slack/Telegram/Discord ids are the platforms' own grammars), and a
 * directory is only claimed when exactly one enabled platform's format
 * matches. Bare digits stay ambiguous while both Telegram and Discord are
 * enabled (negative ids are Telegram-only); anything matching no enabled
 * format fails closed to needs-owner.
 */
function platformsMatchingConversationIdFormat(
  rawConversationId: string,
  enabledPlatforms: readonly PlatformName[],
): PlatformName[] {
  return enabledPlatforms.filter((platform) => {
    switch (platform) {
      case "github":
        return isGithubConversationId(rawConversationId);
      case "telegram":
        return /^-?\d+$/.test(rawConversationId);
      case "discord":
        return /^\d+$/.test(rawConversationId);
      case "slack":
        return /^[A-Z][A-Z0-9]*$/.test(rawConversationId);
    }
  });
}

function isGithubConversationId(rawConversationId: string): boolean {
  try {
    parseGithubConversationId(rawConversationId);
    return true;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

// ── Boot-time legacy migration ────────────────────────────────────────────────
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
  /** Raw ids whose host state dirs (settings, extensions, data) moved. */
  stateDirsMigrated: string[];
  /** Raw ids whose legacy and office-key state dirs both exist (manual merge). */
  stateDirConflicts: string[];
}

/**
 * Move every legacy raw-id office directory under the workspace root to the
 * canonical office-key layout, journaling each move through the office
 * registry so an interrupted run resumes instead of losing offices.
 *
 * The engine never guesses: with several enabled platforms an unowned raw
 * directory stays in place and is reported for `mikan office claim`. Callers
 * must treat a non-empty `unowned`/`failed` as fatal for daemon boot — after
 * the layout flip, an unmigrated legacy directory is invisible to the
 * runtime, which would silently present the conversation as empty.
 */
export function migrateLegacyOffices(options: {
  workspaceRoot: string;
  stateDir: string;
  enabledPlatforms: readonly PlatformName[];
}): OfficeMigrationRunSummary {
  const registry = new OfficeRegistry(options.stateDir);
  for (const platform of options.enabledPlatforms) registry.enablePlatform(platform);

  const summary: OfficeMigrationRunSummary = {
    migrated: [],
    recovered: [],
    unowned: [],
    failed: [],
    vaultKeysMigrated: [],
    vaultConflicts: [],
    stateDirsMigrated: [],
    stateDirConflicts: [],
  };

  recoverInterruptedMoves(registry, summary);
  claimAndMoveLegacyDirs(registry, options.workspaceRoot, summary);

  // Credential vaults are keyed by office too; the registry inventory (which
  // the directory moves above just extended) drives the same rename.
  const vaults = migrateConversationVaultKeys({
    stateDir: options.stateDir,
    offices: registry.getOffices(),
  });
  summary.vaultKeysMigrated = vaults.migrated;
  summary.vaultConflicts = vaults.conflicts;
  for (const rawConversationId of vaults.migrated) {
    log.logInfo(`[office] Migrated vault key to office key: ${rawConversationId}`);
  }

  migrateConversationStateDirs(registry, options.stateDir, summary);

  for (const record of registry.getState().migrations) {
    if (record.status === "needs-owner") summary.unowned.push(record.rawConversationId);
    else if (record.status === "failed") summary.failed.push(record.rawConversationId);
  }
  return summary;
}

/** Complete or fail every move the journal says was interrupted mid-rename. */
function recoverInterruptedMoves(
  registry: OfficeRegistry,
  summary: OfficeMigrationRunSummary,
): void {
  for (const record of registry.getState().migrations) {
    if (record.status !== "moving") continue;
    const targetDir = record.targetDir;
    if (!targetDir) {
      registry.markFailed(record.rawConversationId, "Moving record has no target directory");
      continue;
    }
    const sourceExists = pathExists(record.sourceDir);
    const targetExists = pathExists(targetDir);
    if (sourceExists && targetExists) {
      registry.markFailed(
        record.rawConversationId,
        "Both legacy source and office target exist; merge them manually",
      );
      continue;
    }
    if (!sourceExists && !targetExists) {
      registry.markFailed(
        record.rawConversationId,
        "Neither legacy source nor office target exists",
      );
      continue;
    }
    if (sourceExists) renameSync(record.sourceDir, targetDir);
    registry.markCommitted(record.rawConversationId);
    recordMigratedOffice(registry, record);
    summary.recovered.push(record.rawConversationId);
    log.logInfo(`[office] Recovered interrupted migration: ${record.rawConversationId}`);
  }
}

/** Scan the workspace root and move every claimable legacy office directory. */
function claimAndMoveLegacyDirs(
  registry: OfficeRegistry,
  workspaceRoot: string,
  summary: OfficeMigrationRunSummary,
): void {
  for (const rawConversationId of listLegacyOfficeDirs(workspaceRoot)) {
    const existing = registry.getMigration(rawConversationId);
    if (existing?.status === "committed") {
      // The move already happened; a raw-id dir with this name reappearing
      // afterwards is a different (or resurrected) office the runtime can no
      // longer see. Refusing to boot beats silently ignoring its data.
      throw new Error(
        `Legacy office directory reappeared after migration: ${join(workspaceRoot, rawConversationId)}`,
      );
    }
    if (existing?.status === "failed") continue; // reported via summary.failed

    const record = registry.prepareLegacyMigration({
      rawConversationId,
      sourceDir: join(workspaceRoot, rawConversationId),
      workspaceRoot,
    });
    if (record.status === "needs-owner") continue; // reported via summary.unowned

    const moving = registry.markMoving(rawConversationId);
    const targetDir = moving.targetDir;
    if (!targetDir) throw new Error("Moving office migration has no target directory");
    renameSync(moving.sourceDir, targetDir);
    registry.markCommitted(rawConversationId);
    recordMigratedOffice(registry, moving);
    summary.migrated.push(rawConversationId);
    log.logInfo(`[office] Migrated office directory: ${rawConversationId} -> ${targetDir}`);
  }
}

/**
 * Move each registered office's host state tree — settings.json, extensions,
 * extension-data, git checkouts — from `conversations/<rawId>` to
 * `conversations/<officeKey>` in one rename. Conflicts are reported for
 * manual merge, never clobbered.
 */
function migrateConversationStateDirs(
  registry: OfficeRegistry,
  stateDir: string,
  summary: OfficeMigrationRunSummary,
): void {
  for (const office of registry.getOffices()) {
    const legacyDir = join(stateDir, "conversations", office.conversationId);
    if (!existsSync(legacyDir)) continue;
    const targetDir = officeStateDir(stateDir, office);
    if (existsSync(targetDir)) {
      summary.stateDirConflicts.push(office.conversationId);
      continue;
    }
    renameSync(legacyDir, targetDir);
    summary.stateDirsMigrated.push(office.conversationId);
    log.logInfo(`[office] Migrated host state dir to office key: ${office.conversationId}`);
  }
}

/** A migrated office is an existing office; keep the directory enumerable. */
function recordMigratedOffice(registry: OfficeRegistry, record: OfficeMigrationRecord): void {
  if (!record.ownerPlatform) return;
  registry.recordOffice({
    platform: record.ownerPlatform,
    conversationId: record.rawConversationId,
  });
}

/**
 * Legacy office candidates: regular directories that are not reserved
 * infrastructure, not hidden, and not already office-key named. A symlink in
 * office position is refused outright — following it could move data from
 * outside the workspace root.
 *
 * A candidate must also look like a conversation office: every office that
 * ever saw a message has a `log.jsonl`, and every office that ran the agent
 * has `sessions/`. Trusted workspace roots legitimately accumulate other
 * directories — repos the agent cloned, build output — which are not offices
 * and must be neither renamed nor reported as unowned; they stay where they
 * are (an operator can still claim one explicitly via `mikan office claim`).
 */
function listLegacyOfficeDirs(workspaceRoot: string): string[] {
  const candidates: string[] = [];
  for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (RESERVED_WORKSPACE_NAMES.has(entry.name)) continue;
    if (isOfficeKey(entry.name)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Workspace entry must not be a symlink: ${join(workspaceRoot, entry.name)}`);
    }
    if (!entry.isDirectory()) continue;
    if (!looksLikeConversationOffice(join(workspaceRoot, entry.name))) {
      log.logInfo(
        `[office] Skipping non-office workspace directory (no log.jsonl or sessions/): ${entry.name}`,
      );
      continue;
    }
    candidates.push(entry.name);
  }
  return candidates.toSorted();
}

function looksLikeConversationOffice(dir: string): boolean {
  return existsSync(join(dir, "log.jsonl")) || existsSync(join(dir, "sessions"));
}

/** Operator-facing boot failure for offices the engine may not move itself. */
export function formatUnmigratedOfficesError(summary: OfficeMigrationRunSummary): string {
  const lines = ["Conversation office migration cannot complete:"];
  if (summary.unowned.length > 0) {
    lines.push(
      "",
      "These legacy conversation directories have no owning platform (several",
      "platforms are enabled, so ownership cannot be inferred):",
      ...summary.unowned.map((id) => `  - ${id}`),
      "",
      "Assign each one with:",
      "  mikan office claim <conversationId> <platform>",
    );
  }
  if (summary.failed.length > 0) {
    lines.push(
      "",
      "These migrations previously failed and need manual repair (see",
      "office-registry.json in the state dir for each error):",
      ...summary.failed.map((id) => `  - ${id}`),
    );
  }
  if (summary.vaultConflicts.length > 0) {
    lines.push(
      "",
      "These conversations have credentials under both the legacy and the",
      "office-key vault directory; merge them manually under <state-dir>/vaults:",
      ...summary.vaultConflicts.map((id) => `  - ${id}`),
    );
  }
  if (summary.stateDirConflicts.length > 0) {
    lines.push(
      "",
      "These conversations have host state under both the legacy and the",
      "office-key directory; merge them manually under <state-dir>/conversations:",
      ...summary.stateDirConflicts.map((id) => `  - ${id}`),
    );
  }
  return lines.join("\n");
}

/**
 * Bind-spec translator for the container layout migration: rewrites every
 * host path the office migration renamed — workspace dirs, per-conversation
 * state trees, conversation vaults — and the guest workspace segment, using
 * the registry's office inventory as the raw-id ↔ office mapping. Specs that
 * reference none of the renamed paths come back unchanged, which is also how
 * an already-migrated container is recognized.
 */
function replacePrefix(path: string, pairs: Array<[string, string]>): string {
  for (const [oldPrefix, newPrefix] of pairs) {
    if (path === oldPrefix) return newPrefix;
    if (path.startsWith(`${oldPrefix}/`)) return newPrefix + path.slice(oldPrefix.length);
  }
  return path;
}

export function buildContainerBindTranslator(options: {
  offices: readonly OfficeRecord[];
  workspaceRoot: string;
  stateDir: string;
}): (bindSpec: string) => string {
  const hostPairs: Array<[string, string]> = [];
  const guestPairs: Array<[string, string]> = [];
  for (const office of options.offices) {
    const key = officeKey(office);
    const rawId = office.conversationId;
    hostPairs.push([join(options.workspaceRoot, rawId), join(options.workspaceRoot, key)]);
    hostPairs.push([
      join(options.stateDir, "conversations", rawId),
      officeStateDir(options.stateDir, office),
    ]);
    hostPairs.push([
      join(options.stateDir, "vaults", legacyConversationCredentialKey(rawId)),
      join(options.stateDir, "vaults", key),
    ]);
    guestPairs.push([`/workspace/${rawId}`, `/workspace/${key}`]);
  }

  return (bindSpec: string): string => {
    const readOnly = bindSpec.endsWith(":ro");
    const spec = readOnly ? bindSpec.slice(0, -3) : bindSpec;
    const separator = spec.indexOf(":");
    if (separator === -1) return bindSpec;
    const source = replacePrefix(spec.slice(0, separator), hostPairs);
    const target = replacePrefix(spec.slice(separator + 1), guestPairs);
    return `${source}:${target}${readOnly ? ":ro" : ""}`;
  };
}
