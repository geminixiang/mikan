import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { atomicWritePrivateFile, isRecord, readTextFileIfExists } from "../../utils/file-guards.js";
import { acquireFileLease } from "../../utils/file-lease.js";
import type {
  CreatedWebLoginSession,
  CreatedWebOAuthTransaction,
  WebAccount,
  WebIdentity,
  WebIdentityClaims,
  WebIdentityProvider,
  WebLoginSession,
  WebOAuthTransaction,
  WebWorkspaceRecord,
} from "./types.js";

const REGISTRY_VERSION = 1;
const REGISTRY_FILE = "registry.json";
const LOCK_FILE = ".registry.lock";
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_OAUTH_TTL_MS = 10 * 60 * 1000;

interface StoredLoginSession {
  tokenHash: string;
  csrfTokenHash: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
}

interface StoredOAuthTransaction {
  stateHash: string;
  provider: WebIdentityProvider;
  codeVerifier: string;
  returnPath: string;
  createdAt: number;
  expiresAt: number;
}

interface WebRegistryState {
  version: 1;
  accounts: WebAccount[];
  identities: WebIdentity[];
  workspaces: WebWorkspaceRecord[];
  sessions: StoredLoginSession[];
  oauthTransactions: StoredOAuthTransaction[];
}

interface WebAuthRegistryOptions {
  now?: () => number;
  writeState?: (path: string, content: string) => void;
  lockTimeoutMs?: number;
  sessionTtlMs?: number;
  oauthTtlMs?: number;
}

/** Host-only authority for Web accounts, workspaces, browser sessions, and OAuth state. */
export class WebAuthRegistry {
  private readonly registryPath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly writeState: (path: string, content: string) => void;
  private readonly lockTimeoutMs: number;
  private readonly sessionTtlMs: number;
  private readonly oauthTtlMs: number;
  private state: WebRegistryState;

  constructor(stateDir: string, options: WebAuthRegistryOptions = {}) {
    const webDir = resolve(stateDir, "web");
    mkdirSync(webDir, { recursive: true, mode: 0o700 });
    assertRegularDirectory(webDir);
    this.registryPath = join(webDir, REGISTRY_FILE);
    this.lockPath = join(webDir, LOCK_FILE);
    this.now = options.now ?? Date.now;
    this.writeState = options.writeState ?? atomicWritePrivateFile;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.oauthTtlMs = options.oauthTtlMs ?? DEFAULT_OAUTH_TTL_MS;
    this.state = this.readState();
  }

  completeOAuthIdentity(claims: WebIdentityClaims): {
    account: WebAccount;
    workspace: WebWorkspaceRecord;
    created: boolean;
  } {
    const normalized = normalizeClaims(claims);
    return this.mutate(() => {
      const existing = this.state.identities.find(
        (identity) =>
          identity.provider === normalized.provider && identity.subject === normalized.subject,
      );
      if (existing) {
        const account = this.requireAccount(existing.accountId);
        const workspace = this.requireDefaultWorkspace(account.id);
        const timestamp = this.now();
        this.replaceAccount(account, {
          ...account,
          displayName: normalized.displayName,
          ...(normalized.avatarUrl ? { avatarUrl: normalized.avatarUrl } : {}),
          updatedAt: timestamp,
        });
        this.replaceIdentity(existing, {
          ...existing,
          ...(normalized.email ? { email: normalized.email } : {}),
          ...(normalized.emailVerified !== undefined
            ? { emailVerified: normalized.emailVerified }
            : {}),
          profileName: normalized.displayName,
          ...(normalized.avatarUrl ? { avatarUrl: normalized.avatarUrl } : {}),
          updatedAt: timestamp,
        });
        return { account: this.requireAccount(account.id), workspace, created: false };
      }

      const timestamp = this.now();
      const account: WebAccount = Object.freeze({
        id: `acc_${uuidv7()}`,
        displayName: normalized.displayName,
        ...(normalized.avatarUrl ? { avatarUrl: normalized.avatarUrl } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const identity: WebIdentity = Object.freeze({
        provider: normalized.provider,
        subject: normalized.subject,
        accountId: account.id,
        ...(normalized.email ? { email: normalized.email } : {}),
        ...(normalized.emailVerified !== undefined
          ? { emailVerified: normalized.emailVerified }
          : {}),
        profileName: normalized.displayName,
        ...(normalized.avatarUrl ? { avatarUrl: normalized.avatarUrl } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      const workspace = makeWorkspace(account.id, "Personal", timestamp);
      this.state.accounts.push(account);
      this.state.identities.push(identity);
      this.state.workspaces.push(workspace);
      return { account, workspace, created: true };
    });
  }

  createWorkspace(accountId: string, name: string): WebWorkspaceRecord {
    const normalizedName = normalizeWorkspaceName(name);
    return this.mutate(() => {
      this.requireAccount(accountId);
      const workspace = makeWorkspace(accountId, normalizedName, this.now());
      this.state.workspaces.push(workspace);
      return workspace;
    });
  }

  listWorkspaces(accountId: string): readonly WebWorkspaceRecord[] {
    this.reload();
    return this.state.workspaces.filter((workspace) => workspace.ownerAccountId === accountId);
  }

  getOwnedWorkspace(accountId: string, workspaceId: string): WebWorkspaceRecord | null {
    this.reload();
    return (
      this.state.workspaces.find(
        (workspace) => workspace.id === workspaceId && workspace.ownerAccountId === accountId,
      ) ?? null
    );
  }

  renameWorkspace(accountId: string, workspaceId: string, name: string): WebWorkspaceRecord | null {
    const normalizedName = normalizeWorkspaceName(name);
    return this.mutate(() => {
      const workspace = this.state.workspaces.find(
        (candidate) => candidate.id === workspaceId && candidate.ownerAccountId === accountId,
      );
      if (!workspace) return null;
      const updated = Object.freeze({ ...workspace, name: normalizedName, updatedAt: this.now() });
      this.state.workspaces[this.state.workspaces.indexOf(workspace)] = updated;
      return updated;
    });
  }

  createLoginSession(accountId: string): CreatedWebLoginSession {
    return this.mutate(() => {
      const account = this.requireAccount(accountId);
      const token = randomSecret();
      const csrfToken = randomSecret();
      const createdAt = this.now();
      const expiresAt = createdAt + this.sessionTtlMs;
      this.state.sessions.push({
        tokenHash: hashSecret(token),
        csrfTokenHash: hashSecret(csrfToken),
        accountId,
        createdAt,
        expiresAt,
      });
      return { token, csrfToken, account, expiresAt };
    });
  }

  resolveLoginSession(token: string, csrfToken?: string): WebLoginSession | null {
    if (!token) return null;
    return this.withExclusiveLease(() => {
      const purged = this.purgeExpiredInMemory();
      const session = this.state.sessions.find(
        (candidate) => candidate.tokenHash === hashSecret(token),
      );
      if (purged) this.persistState();
      if (!session) return null;
      if (csrfToken !== undefined && session.csrfTokenHash !== hashSecret(csrfToken)) return null;
      return { account: this.requireAccount(session.accountId), expiresAt: session.expiresAt };
    });
  }

  revokeLoginSession(token: string): boolean {
    if (!token) return false;
    return this.mutate(() => {
      const tokenHash = hashSecret(token);
      const index = this.state.sessions.findIndex((session) => session.tokenHash === tokenHash);
      if (index === -1) return false;
      this.state.sessions.splice(index, 1);
      return true;
    });
  }

  createOAuthTransaction(
    provider: WebIdentityProvider,
    returnPath: string,
  ): CreatedWebOAuthTransaction {
    const normalizedReturnPath = normalizeReturnPath(returnPath);
    return this.mutate(() => {
      this.purgeExpiredInMemory();
      const state = randomSecret();
      const codeVerifier = randomSecret(64);
      const createdAt = this.now();
      const expiresAt = createdAt + this.oauthTtlMs;
      this.state.oauthTransactions.push({
        stateHash: hashSecret(state),
        provider,
        codeVerifier,
        returnPath: normalizedReturnPath,
        createdAt,
        expiresAt,
      });
      return { state, codeVerifier, expiresAt };
    });
  }

  consumeOAuthTransaction(
    state: string,
    provider: WebIdentityProvider,
  ): WebOAuthTransaction | null {
    if (!state) return null;
    return this.mutate(() => {
      this.purgeExpiredInMemory();
      const stateHash = hashSecret(state);
      const index = this.state.oauthTransactions.findIndex(
        (transaction) => transaction.stateHash === stateHash && transaction.provider === provider,
      );
      if (index === -1) return null;
      const [transaction] = this.state.oauthTransactions.splice(index, 1);
      if (!transaction) return null;
      return {
        provider: transaction.provider,
        codeVerifier: transaction.codeVerifier,
        returnPath: transaction.returnPath,
        expiresAt: transaction.expiresAt,
      };
    });
  }

  purgeExpired(): void {
    this.mutate(() => this.purgeExpiredInMemory());
  }

  /** Exposed for diagnostics/tests without revealing secret hashes. */
  snapshot(): {
    accounts: readonly WebAccount[];
    identities: readonly WebIdentity[];
    workspaces: readonly WebWorkspaceRecord[];
    sessionCount: number;
    oauthTransactionCount: number;
  } {
    this.reload();
    return {
      accounts: this.state.accounts,
      identities: this.state.identities,
      workspaces: this.state.workspaces,
      sessionCount: this.state.sessions.length,
      oauthTransactionCount: this.state.oauthTransactions.length,
    };
  }

  private mutate<T>(operation: () => T): T {
    return this.withExclusiveLease(() => {
      const result = operation();
      this.persistState();
      return result;
    });
  }

  private withExclusiveLease<T>(operation: () => T): T {
    const release = acquireFileLease(this.lockPath, {
      timeoutMs: this.lockTimeoutMs,
      label: "web auth registry",
    });
    try {
      this.state = this.readState();
      return operation();
    } catch (error) {
      // Operations may mutate the in-memory candidate before the atomic write.
      // Restore durable state so this instance cannot expose an uncommitted value.
      this.state = this.readState();
      throw error;
    } finally {
      release();
    }
  }

  private persistState(): void {
    this.writeState(this.registryPath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  private reload(): void {
    this.state = this.readState();
  }

  private readState(): WebRegistryState {
    assertRegularFileIfPresent(this.registryPath);
    const raw = readTextFileIfExists(this.registryPath);
    if (raw === undefined) return emptyState();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid web auth registry JSON at ${this.registryPath}`, { cause: error });
    }
    return parseState(value, this.registryPath);
  }

  private purgeExpiredInMemory(): boolean {
    const now = this.now();
    const sessionCount = this.state.sessions.length;
    const transactionCount = this.state.oauthTransactions.length;
    this.state.sessions = this.state.sessions.filter((session) => session.expiresAt > now);
    this.state.oauthTransactions = this.state.oauthTransactions.filter(
      (transaction) => transaction.expiresAt > now,
    );
    return (
      sessionCount !== this.state.sessions.length ||
      transactionCount !== this.state.oauthTransactions.length
    );
  }

  private requireAccount(accountId: string): WebAccount {
    const account = this.state.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error(`Unknown web account: ${accountId}`);
    return account;
  }

  private requireDefaultWorkspace(accountId: string): WebWorkspaceRecord {
    const workspace = this.state.workspaces.find(
      (candidate) => candidate.ownerAccountId === accountId,
    );
    if (!workspace) throw new Error(`Web account ${accountId} has no workspace`);
    return workspace;
  }

  private replaceAccount(previous: WebAccount, next: WebAccount): void {
    this.state.accounts[this.state.accounts.indexOf(previous)] = Object.freeze(next);
  }

  private replaceIdentity(previous: WebIdentity, next: WebIdentity): void {
    this.state.identities[this.state.identities.indexOf(previous)] = Object.freeze(next);
  }
}

function emptyState(): WebRegistryState {
  return {
    version: REGISTRY_VERSION,
    accounts: [],
    identities: [],
    workspaces: [],
    sessions: [],
    oauthTransactions: [],
  };
}

function makeWorkspace(accountId: string, name: string, timestamp: number): WebWorkspaceRecord {
  return Object.freeze({
    id: `wsp_${uuidv7()}`,
    ownerAccountId: accountId,
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function normalizeClaims(claims: WebIdentityClaims): WebIdentityClaims {
  if (claims.provider !== "github" && claims.provider !== "google") {
    throw new Error("Unsupported web identity provider");
  }
  const subject = claims.subject.trim();
  if (!subject) throw new Error("Web identity subject must not be empty");
  const displayName = claims.displayName.trim();
  if (!displayName) throw new Error("Web account display name must not be empty");
  return {
    provider: claims.provider,
    subject,
    displayName,
    ...(claims.email?.trim() ? { email: claims.email.trim() } : {}),
    ...(claims.emailVerified !== undefined ? { emailVerified: claims.emailVerified } : {}),
    ...(claims.avatarUrl?.trim() ? { avatarUrl: claims.avatarUrl.trim() } : {}),
  };
}

function normalizeWorkspaceName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 100) {
    throw new Error("Workspace name must be between 1 and 100 characters");
  }
  return normalized;
}

export function normalizeReturnPath(returnPath: string): string {
  const normalized = returnPath.trim() || "/";
  if (
    !normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    normalized.includes("\\") ||
    /[ -]/.test(normalized)
  ) {
    throw new Error("OAuth return path must be a local absolute path");
  }
  return normalized;
}

function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function parseState(value: unknown, path: string): WebRegistryState {
  if (!isRecord(value) || value.version !== REGISTRY_VERSION) {
    throw new Error(`Invalid web auth registry version at ${path}`);
  }
  const collections = [
    value.accounts,
    value.identities,
    value.workspaces,
    value.sessions,
    value.oauthTransactions,
  ];
  if (!collections.every(Array.isArray)) {
    throw new Error(`Invalid web auth registry shape at ${path}`);
  }
  const [accountValues, identityValues, workspaceValues, sessionValues, transactionValues] =
    collections as [unknown[], unknown[], unknown[], unknown[], unknown[]];
  const accounts = accountValues.map((item) => parseAccount(item, path));
  const identities = identityValues.map((item) => parseIdentity(item, path));
  const workspaces = workspaceValues.map((item) => parseWorkspace(item, path));
  const sessions = sessionValues.map((item) => parseSession(item, path));
  const oauthTransactions = transactionValues.map((item) => parseTransaction(item, path));

  assertUnique(
    accounts.map((account) => account.id),
    "account id",
    path,
  );
  assertUnique(
    identities.map((identity) => `${identity.provider}\0${identity.subject}`),
    "identity",
    path,
  );
  assertUnique(
    workspaces.map((workspace) => workspace.id),
    "workspace id",
    path,
  );
  assertUnique(
    sessions.map((session) => session.tokenHash),
    "login session",
    path,
  );
  assertUnique(
    oauthTransactions.map((transaction) => transaction.stateHash),
    "OAuth transaction",
    path,
  );
  const accountIds = new Set(accounts.map((account) => account.id));
  for (const accountId of [
    ...identities.map((identity) => identity.accountId),
    ...workspaces.map((workspace) => workspace.ownerAccountId),
    ...sessions.map((session) => session.accountId),
  ]) {
    if (!accountIds.has(accountId)) throw new Error(`Unknown account reference in ${path}`);
  }
  return {
    version: REGISTRY_VERSION,
    accounts,
    identities,
    workspaces,
    sessions,
    oauthTransactions,
  };
}

function parseAccount(value: unknown, path: string): WebAccount {
  const record = requireRecord(value, "account", path);
  const id = requirePrefixedId(record.id, "acc_", "account", path);
  const avatarUrl = optionalString(record.avatarUrl, "account avatar", path);
  return Object.freeze({
    id,
    displayName: requireString(record.displayName, "account display name", path),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    createdAt: requireTimestamp(record.createdAt, "account createdAt", path),
    updatedAt: requireTimestamp(record.updatedAt, "account updatedAt", path),
  });
}

function parseIdentity(value: unknown, path: string): WebIdentity {
  const record = requireRecord(value, "identity", path);
  const provider = requireProvider(record.provider, path);
  const email = optionalString(record.email, "identity email", path);
  const profileName = optionalString(record.profileName, "identity profile name", path);
  const avatarUrl = optionalString(record.avatarUrl, "identity avatar", path);
  return Object.freeze({
    provider,
    subject: requireString(record.subject, "identity subject", path),
    accountId: requirePrefixedId(record.accountId, "acc_", "identity account", path),
    ...(email !== undefined ? { email } : {}),
    ...(record.emailVerified === undefined
      ? {}
      : typeof record.emailVerified === "boolean"
        ? { emailVerified: record.emailVerified }
        : fail("identity emailVerified", path)),
    ...(profileName !== undefined ? { profileName } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    createdAt: requireTimestamp(record.createdAt, "identity createdAt", path),
    updatedAt: requireTimestamp(record.updatedAt, "identity updatedAt", path),
  });
}

function parseWorkspace(value: unknown, path: string): WebWorkspaceRecord {
  const record = requireRecord(value, "workspace", path);
  return Object.freeze({
    id: requirePrefixedId(record.id, "wsp_", "workspace", path),
    ownerAccountId: requirePrefixedId(record.ownerAccountId, "acc_", "workspace owner", path),
    name: requireString(record.name, "workspace name", path),
    createdAt: requireTimestamp(record.createdAt, "workspace createdAt", path),
    updatedAt: requireTimestamp(record.updatedAt, "workspace updatedAt", path),
  });
}

function parseSession(value: unknown, path: string): StoredLoginSession {
  const record = requireRecord(value, "session", path);
  return {
    tokenHash: requireHash(record.tokenHash, "session token", path),
    csrfTokenHash: requireHash(record.csrfTokenHash, "session CSRF token", path),
    accountId: requirePrefixedId(record.accountId, "acc_", "session account", path),
    createdAt: requireTimestamp(record.createdAt, "session createdAt", path),
    expiresAt: requireTimestamp(record.expiresAt, "session expiresAt", path),
  };
}

function parseTransaction(value: unknown, path: string): StoredOAuthTransaction {
  const record = requireRecord(value, "OAuth transaction", path);
  return {
    stateHash: requireHash(record.stateHash, "OAuth state", path),
    provider: requireProvider(record.provider, path),
    codeVerifier: requireString(record.codeVerifier, "OAuth PKCE verifier", path),
    returnPath: normalizeReturnPath(requireString(record.returnPath, "OAuth return path", path)),
    createdAt: requireTimestamp(record.createdAt, "OAuth createdAt", path),
    expiresAt: requireTimestamp(record.expiresAt, "OAuth expiresAt", path),
  };
}

function requireRecord(value: unknown, label: string, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Invalid ${label} in ${path}`);
  return value;
}

function requireString(value: unknown, label: string, path: string): string {
  if (typeof value !== "string" || !value) return fail(label, path);
  return value;
}

function optionalString(value: unknown, label: string, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) return fail(label, path);
  return value;
}

function requireTimestamp(value: unknown, label: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fail(label, path);
  return value;
}

function requirePrefixedId(value: unknown, prefix: string, label: string, path: string): string {
  const id = requireString(value, label, path);
  if (!id.startsWith(prefix)) return fail(label, path);
  return id;
}

function requireHash(value: unknown, label: string, path: string): string {
  const hash = requireString(value, label, path);
  if (!/^[a-f0-9]{64}$/.test(hash)) return fail(label, path);
  return hash;
}

function requireProvider(value: unknown, path: string): WebIdentityProvider {
  if (value !== "github" && value !== "google") return fail("identity provider", path);
  return value;
}

function assertUnique(values: string[], label: string, path: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} in ${path}`);
}

function fail(label: string, path: string): never {
  throw new Error(`Invalid ${label} in ${path}`);
}

function assertRegularDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Web auth state directory must be a regular directory: ${path}`);
  }
}

function assertRegularFileIfPresent(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Web auth registry must be a regular file: ${path}`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
