import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  OfficeAddress,
  OfficeMigrationPreparation,
  OfficeMigrationRecord,
  OfficeMigrationStatus,
  OfficeRecord,
  OfficeRegistryState,
  PlatformName,
} from "../types.js";
import {
  officeDir,
  officeKey,
  assertConversationId,
  assertPlatformName,
  validateOfficeAddress,
} from "./address.js";
import { parseGithubConversationId } from "../adapters/github/ids.js";
import { isRecord, readTextFileIfExists } from "../utils/file-guards.js";
import { atomicWritePrivateFile } from "../utils/file-guards.js";

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
  if (matches.length === 1) {
    return { platform: matches[0].platform, conversationId: rawConversationId };
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
  if (enabledPlatforms.length === 1) {
    return { platform: enabledPlatforms[0], conversationId: rawConversationId };
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
