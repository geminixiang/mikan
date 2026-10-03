import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ConversationEvent,
  ConversationMessage,
  OfficeAddress,
  OfficeKey,
  OfficeRecord,
  OfficeRegistryState,
  PlatformName,
} from "../types.js";
import type { GithubConversationRef, Office, Workspace } from "./types.js";
import { atomicWritePrivateFile, readTextFileIfExists } from "../file-guards.js";
import { isRecord } from "../unknown-values.js";

export const OFFICE_LOG_FILENAME = "log.jsonl";
const OFFICE_SESSIONS_FILENAME = "sessions.db";
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
      const conversationStateDir = join(stateDir, "conversations", key);
      const office: Office = Object.freeze({
        address: normalized,
        key,
        dir,
        memoryPath: join(dir, "MEMORY.md"),
        skillsDir: join(dir, "skills"),
        sessionsPath: join(conversationStateDir, OFFICE_SESSIONS_FILENAME),
        attachmentsDir: join(dir, "attachments"),
        logPath: join(dir, OFFICE_LOG_FILENAME),
        stateDir: conversationStateDir,
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
      this.replaceState([...this.state.offices, record]);
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

  private replaceState(offices: readonly OfficeRecord[]): void {
    const candidate = freezeState(offices);
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
      return freezeState([]);
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

function freezeState(offices: readonly OfficeRecord[]): OfficeRegistryState {
  return Object.freeze({
    version: REGISTRY_VERSION as 1,
    offices: Object.freeze(offices.map((record) => Object.freeze({ ...record }))),
  });
}

function parseState(value: unknown, path: string): OfficeRegistryState {
  if (!isRecord(value) || value.version !== REGISTRY_VERSION || !Array.isArray(value.offices)) {
    throw new Error(`Invalid office registry at ${path}`);
  }
  const offices = value.offices.map((entry) => parseOfficeRecord(entry, path));
  if (new Set(offices.map((record) => officeKey(record))).size !== offices.length) {
    throw new Error(`Duplicate office record in ${path}`);
  }
  return freezeState(offices);
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

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
