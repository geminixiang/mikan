import { createHash, randomBytes } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
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
  ConversationEvent,
  ConversationMessage,
  OfficeAddress,
  OfficeKey,
  OfficeMigrationPreparation,
  OfficeMigrationRecord,
  OfficeMigrationStatus,
  OfficeRecord,
  OfficeRegistryState,
  PlatformName,
} from "../types.js";
import type {
  GithubConversationRef,
  Office,
  OfficeMigrationRunSummary,
  Workspace,
} from "./types.js";
import { legacyConversationCredentialKey } from "../sandbox/identity.js";
import { guestWorkspacePath } from "../sandbox/layout.js";
import { migrateConversationVaultKeys } from "../vault/index.js";
import { atomicWritePrivateFile, readTextFileIfExists } from "../file-guards.js";
import { isRecord } from "../unknown-values.js";

export const OFFICE_LOG_FILENAME = "log.jsonl";
const OFFICE_KEY_VERSION = "v1";
const OFFICE_KEY_DOMAIN = "office-address-v1";
const OFFICE_KEY_DIGEST_LENGTH = 16;
const READABLE_ID_LENGTH = 32;
const PLATFORM_NAMES = new Set<PlatformName>(["slack", "discord", "telegram", "github"]);
const OFFICE_KEY_PATTERN =
  /^v1-(slack|discord|telegram|github)-[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{16}$/;

export function createOfficeAddress(platform: PlatformName, conversationId: string): OfficeAddress {
  assertPlatformName(platform);
  assertConversationId(conversationId);
  return Object.freeze({ platform, conversationId });
}

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

function isPlatformName(value: unknown): value is PlatformName {
  return typeof value === "string" && PLATFORM_NAMES.has(value as PlatformName);
}

export function assertPlatformName(value: string): PlatformName {
  if (!isPlatformName(value)) throw new Error(`Unsupported platform: ${JSON.stringify(value)}`);
  return value;
}

function isUnsafeConversationIdChar(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return character === "/" || character === "\\" || code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

export function assertConversationId(value: string): string {
  if (value.length === 0 || value === "." || value === "..") {
    throw new Error("Conversation id must be non-empty and not a path marker");
  }
  if ([...value].some(isUnsafeConversationIdChar)) {
    throw new Error("Conversation id must not contain path separators or control characters");
  }
  return value;
}

export function officeKey(address: OfficeAddress): OfficeKey {
  const normalized = validateOfficeAddress(address);
  const readable = readableConversationId(normalized.conversationId);
  const digest = createHash("sha256")
    .update(`${OFFICE_KEY_DOMAIN}\0${normalized.platform}\0${normalized.conversationId}`)
    .digest("hex")
    .slice(0, OFFICE_KEY_DIGEST_LENGTH);
  return `${OFFICE_KEY_VERSION}-${normalized.platform}-${readable}-${digest}` as OfficeKey;
}

export function officeDir(workspaceRoot: string, address: OfficeAddress): string {
  return join(workspaceRoot, officeKey(address));
}

export function officeStateDir(stateDir: string, address: OfficeAddress): string {
  return join(stateDir, "conversations", officeKey(address));
}

export function sameOffice(left: OfficeAddress, right: OfficeAddress): boolean {
  const leftAddress = validateOfficeAddress(left);
  const rightAddress = validateOfficeAddress(right);
  return (
    leftAddress.platform === rightAddress.platform &&
    leftAddress.conversationId === rightAddress.conversationId
  );
}

interface ConversationIdentityInput {
  platform: PlatformName;
  conversationId: string;
  address?: OfficeAddress;
}

function resolveConversationAddress(input: ConversationIdentityInput): OfficeAddress {
  const address = createOfficeAddress(input.platform, input.conversationId);
  if (input.address && !sameOffice(address, input.address)) {
    throw new Error(
      `Conversation address mismatch for ${JSON.stringify(input.conversationId)} on ${input.platform}`,
    );
  }
  return address;
}

type CanonicalConversation<T, Shape> = Omit<T, keyof ConversationIdentityInput> & Shape;

export function createConversationEvent<T extends Omit<ConversationEvent, "address">>(
  input: T & ConversationIdentityInput,
): CanonicalConversation<T, ConversationEvent> {
  const address = resolveConversationAddress(input);
  const {
    platform: _platform,
    conversationId: _conversationId,
    address: _suppliedAddress,
    ...event
  } = input;
  return { ...event, address } as CanonicalConversation<T, ConversationEvent>;
}

export function createConversationMessage<T extends Omit<ConversationMessage, "address">>(
  input: T & ConversationIdentityInput,
): CanonicalConversation<T, ConversationMessage> {
  const address = resolveConversationAddress(input);
  const {
    platform: _platform,
    conversationId: _conversationId,
    address: _suppliedAddress,
    ...message
  } = input;
  return { ...message, address } as CanonicalConversation<T, ConversationMessage>;
}

export function buildGithubConversationId(ref: GithubConversationRef): string {
  return `GH_${ref.owner.toLowerCase()}_${ref.repo.toLowerCase()}_${ref.number}`;
}

const GITHUB_CONVERSATION_ID_PATTERN = /^GH_([A-Za-z0-9-]+)_(.+)_(\d+)$/;

export function parseGithubConversationId(conversationId: string): GithubConversationRef {
  const match = GITHUB_CONVERSATION_ID_PATTERN.exec(conversationId);
  if (!match) {
    throw new Error(`Not a GitHub conversation id: ${conversationId}`);
  }
  const [, owner, repo, number] = match;
  if (owner === undefined || repo === undefined || number === undefined) {
    throw new Error(`Not a GitHub conversation id: ${conversationId}`);
  }
  return {
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase(),
    number: Number(number),
  };
}

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

export const RESERVED_WORKSPACE_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(["skills", "events", "agents", "MEMORY.md"]),
);

export function officeSessionsDir(dir: string): string {
  return join(dir, "sessions");
}

export function createWorkspace(options: { root: string; stateDir: string }): Workspace {
  const { root, stateDir } = options;
  let registry: OfficeRegistry | undefined;
  const recorded = new Set<string>();
  const offices = new Map<string, Office>();

  const workspace: Workspace = Object.freeze({
    root,
    stateDir,
    memoryPath: join(root, "MEMORY.md"),
    skillsDir: join(root, "skills"),
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
        logPath: join(dir, OFFICE_LOG_FILENAME),
        stateDir: join(stateDir, "conversations", key),
        workspace,
        ensure(): string {
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
    ownerPlatform: fields.ownerPlatform ? fields.ownerPlatform : undefined,
    targetDir: fields.targetDir ? fields.targetDir : undefined,
    status: fields.status,
    error: fields.error ? fields.error : undefined,
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
    ownerPlatform: record.ownerPlatform,
    targetDir,
    status,
    error,
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

interface MigrationFields {
  rawConversationId: string;
  sourceDir: string;
  workspaceRoot: string;
  status: OfficeMigrationStatus;
  updatedAt: string;
}

function hasMigrationStrings(
  value: Record<string, unknown>,
): value is Record<string, unknown> & Record<keyof MigrationFields, string> {
  return (
    typeof value.rawConversationId === "string" &&
    typeof value.sourceDir === "string" &&
    typeof value.workspaceRoot === "string" &&
    typeof value.status === "string" &&
    typeof value.updatedAt === "string"
  );
}

function parseMigrationFields(value: Record<string, unknown>, path: string): MigrationFields {
  if (!hasMigrationStrings(value)) {
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
  return {
    rawConversationId: value.rawConversationId,
    sourceDir: value.sourceDir,
    workspaceRoot: value.workspaceRoot,
    status: value.status as OfficeMigrationStatus,
    updatedAt: value.updatedAt,
  };
}

function assertOwnershipMatchesStatus(
  status: OfficeMigrationStatus,
  ownerPlatform: PlatformName | undefined,
  targetDir: string | undefined,
  path: string,
): void {
  const owned = ownerPlatform !== undefined;
  const targeted = targetDir !== undefined;
  if (status === "needs-owner" && (owned || targeted)) {
    throw new Error(`Needs-owner migration cannot have an owner or target in ${path}`);
  }
  if (status !== "needs-owner" && status !== "failed" && !(owned && targeted)) {
    throw new Error(`Prepared office migration is missing ownership in ${path}`);
  }
  if (!owned && targeted) {
    throw new Error(`Office migration target has no owner in ${path}`);
  }
}

function parseRecord(
  value: unknown,
  path: string,
  enabledPlatforms: readonly PlatformName[],
): OfficeMigrationRecord {
  if (!isRecord(value)) throw new Error(`Invalid office migration record in ${path}`);
  const fields = parseMigrationFields(value, path);
  const ownerPlatform = optionalPlatform(value.ownerPlatform);
  const targetDir = optionalString(value.targetDir);
  const error = optionalString(value.error);

  if (ownerPlatform !== undefined && !enabledPlatforms.includes(ownerPlatform)) {
    throw new Error(`Office migration owner is not enabled in ${path}`);
  }
  assertOwnershipMatchesStatus(fields.status, ownerPlatform, targetDir, path);

  const expectedTargetDir = ownerPlatform
    ? officeDir(fields.workspaceRoot, {
        platform: ownerPlatform,
        conversationId: fields.rawConversationId,
      })
    : undefined;
  if (targetDir !== expectedTargetDir) {
    throw new Error(`Office migration target does not match its office address in ${path}`);
  }
  if (fields.status === "failed" && !error) {
    throw new Error(`Failed office migration is missing an error in ${path}`);
  }

  return buildMigrationRecord(fields, ownerPlatform, expectedTargetDir, error);
}

function buildMigrationRecord(
  fields: MigrationFields,
  ownerPlatform: PlatformName | undefined,
  targetDir: string | undefined,
  error: string | undefined,
): OfficeMigrationRecord {
  return makeRecord({
    rawConversationId: fields.rawConversationId,
    sourceDir: fields.sourceDir,
    workspaceRoot: fields.workspaceRoot,
    ownerPlatform,
    targetDir,
    status: fields.status,
    error,
    updatedAt: fields.updatedAt,
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

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertRegistryFileSafe(path: string): void {
  const stat = lstatIfExists(path);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new Error(`Office registry must be a regular file: ${path}`);
  }
}

function assertPathIfPresent(path: string, label: string): void {
  const stat = lstatIfExists(path);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new Error(`${label} must be a regular directory: ${path}`);
  }
}

function assertPathAbsent(path: string, label: string): void {
  if (lstatIfExists(path)) throw new Error(`${label} must be absent: ${path}`);
}

function pathExists(path: string): boolean {
  return lstatIfExists(path) !== undefined;
}

function claimRegistryLock(lockPath: string, token: string): void {
  mkdirSync(lockPath, { mode: 0o700 });
  try {
    writeFileSync(join(lockPath, "owner"), `${token}\n`, { mode: 0o600 });
  } catch (error) {
    rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
}

function acquireRegistryLease(lockPath: string, timeoutMs: number): () => void {
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;

  for (;;) {
    try {
      claimRegistryLock(lockPath, token);
      return () => releaseRegistryLease(lockPath, token);
    } catch (error) {
      awaitFreeRegistryLock(lockPath, deadline, error);
    }
  }
}

function awaitFreeRegistryLock(lockPath: string, deadline: number, error: unknown): void {
  if (!isErrno(error, "EEXIST")) throw error;
  if (registryLockIsStale(lockPath)) {
    rmSync(lockPath, { recursive: true, force: true });
    return;
  }
  if (Date.now() >= deadline) {
    throw new Error(`Timed out acquiring office registry lock: ${lockPath}`, { cause: error });
  }
  sleepSync(REGISTRY_LOCK_RETRY_MS);
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
  } catch {}
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

export function listRegisteredOffices(stateDir: string): readonly OfficeRecord[] {
  return new OfficeRegistry(stateDir).getOffices();
}

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

function recoverInterruptedMoves(
  registry: OfficeRegistry,
  summary: OfficeMigrationRunSummary,
): void {
  for (const record of registry.getState().migrations) {
    if (record.status !== "moving") continue;
    const failure = finishInterruptedMove(record);
    if (failure) {
      registry.markFailed(record.rawConversationId, failure);
      continue;
    }
    registry.markCommitted(record.rawConversationId);
    recordMigratedOffice(registry, record);
    summary.recovered.push(record.rawConversationId);
    log.logInfo(`[office] Recovered interrupted migration: ${record.rawConversationId}`);
  }
}

function finishInterruptedMove(record: OfficeMigrationRecord): string | undefined {
  const targetDir = record.targetDir;
  if (!targetDir) return "Moving record has no target directory";
  const sourceExists = pathExists(record.sourceDir);
  const targetExists = pathExists(targetDir);
  if (sourceExists && targetExists) {
    return "Both legacy source and office target exist; merge them manually";
  }
  if (!sourceExists && !targetExists) return "Neither legacy source nor office target exists";
  if (sourceExists) renameSync(record.sourceDir, targetDir);
  return undefined;
}

function isClaimableLegacyDir(
  registry: OfficeRegistry,
  workspaceRoot: string,
  rawConversationId: string,
): boolean {
  const existing = registry.getMigration(rawConversationId);
  if (existing?.status === "committed") {
    throw new Error(
      `Legacy office directory reappeared after migration: ${join(workspaceRoot, rawConversationId)}`,
    );
  }
  return existing?.status !== "failed";
}

function claimAndMoveLegacyDirs(
  registry: OfficeRegistry,
  workspaceRoot: string,
  summary: OfficeMigrationRunSummary,
): void {
  for (const rawConversationId of listLegacyOfficeDirs(workspaceRoot)) {
    if (!isClaimableLegacyDir(registry, workspaceRoot, rawConversationId)) continue;

    const record = registry.prepareLegacyMigration({
      rawConversationId,
      sourceDir: join(workspaceRoot, rawConversationId),
      workspaceRoot,
    });
    if (record.status === "needs-owner") continue;

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

function recordMigratedOffice(registry: OfficeRegistry, record: OfficeMigrationRecord): void {
  if (!record.ownerPlatform) return;
  registry.recordOffice({
    platform: record.ownerPlatform,
    conversationId: record.rawConversationId,
  });
}

function listLegacyOfficeDirs(workspaceRoot: string): string[] {
  return readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((entry) => isLegacyOfficeDir(workspaceRoot, entry))
    .map((entry) => entry.name)
    .toSorted();
}

function isLegacyOfficeDir(workspaceRoot: string, entry: Dirent): boolean {
  if (entry.name.startsWith(".")) return false;
  if (RESERVED_WORKSPACE_NAMES.has(entry.name)) return false;
  if (isOfficeKey(entry.name)) return false;
  if (entry.isSymbolicLink()) {
    throw new Error(`Workspace entry must not be a symlink: ${join(workspaceRoot, entry.name)}`);
  }
  if (!entry.isDirectory()) return false;
  if (looksLikeConversationOffice(join(workspaceRoot, entry.name))) return true;
  log.logInfo(
    `[office] Skipping non-office workspace directory (no ${OFFICE_LOG_FILENAME} or sessions/): ${entry.name}`,
  );
  return false;
}

function looksLikeConversationOffice(dir: string): boolean {
  return existsSync(join(dir, OFFICE_LOG_FILENAME)) || existsSync(join(dir, "sessions"));
}

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
  lines.push(
    ...conflictSection(summary.failed, [
      "These migrations previously failed and need manual repair (see",
      "office-registry.json in the state dir for each error):",
    ]),
    ...conflictSection(summary.vaultConflicts, [
      "These conversations have credentials under both the legacy and the",
      "office-key vault directory; merge them manually under <state-dir>/vaults:",
    ]),
    ...conflictSection(summary.stateDirConflicts, [
      "These conversations have host state under both the legacy and the",
      "office-key directory; merge them manually under <state-dir>/conversations:",
    ]),
  );
  return lines.join("\n");
}

function conflictSection(ids: readonly string[], explanation: string[]): string[] {
  if (ids.length === 0) return [];
  return ["", ...explanation, ...ids.map((id) => `  - ${id}`)];
}

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
    guestPairs.push([guestWorkspacePath(rawId), guestWorkspacePath(key)]);
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
