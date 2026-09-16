/**
 * OpenConnector is an ordinary MCP server with one deployment-provided
 * default. When a Slack office has not declared `open-connector` in global or
 * conversation settings, the host mints a runtime token for that office with
 * the startup admin token and writes a plain conversation `mcpServers` entry.
 * From then on the entry is loaded, tested, disabled, or removed like any
 * other MCP server; the admin token itself never leaves this module.
 */
import { Type } from "@sinclair/typebox";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readEnv } from "../env-manifest.js";
import * as log from "../log.js";
import { loadScopeMcpServers, updateConversationSettings } from "../settings/index.js";
import { isRecord, readJsonSchemaFileIfExists } from "../file-guards.js";
import {
  createWorkspace,
  isOfficeKey,
  listRegisteredOffices,
  officeKey,
  type Office,
} from "../office/index.js";
import type { OfficeKey } from "../types.js";
import type { McpServerConfig } from "./types.js";

const OPEN_CONNECTOR_SERVER = "open-connector";
const LEGACY_TOKEN_FILE = "open-connector-runtime-token.json";
const REQUEST_TIMEOUT_MS = 10_000;
const pending = new Map<string, Promise<void>>();

const LegacyTokenSchema = Type.Object(
  {
    version: Type.Literal(1),
    origin: Type.String(),
    name: Type.String(),
    id: Type.String(),
    token: Type.String(),
  },
  { additionalProperties: false },
);

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`OpenConnector returned an invalid ${field}`);
  }
  return value;
}

async function readJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`OpenConnector ${operation} failed with HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`OpenConnector ${operation} returned invalid JSON`, { cause: error });
  }
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Mint a runtime token that copies the deployment's current action policy. */
async function createRuntimeToken(
  origin: string,
  adminToken: string,
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  const headers = { Authorization: `Bearer ${adminToken}` };
  const policyValue = await readJson(
    await fetch(new URL("/api/runtime-policy", origin), { headers, signal: requestSignal(signal) }),
    "runtime policy request",
  );
  if (!isRecord(policyValue) || !isRecord(policyValue.deployment)) {
    throw new Error("OpenConnector returned an invalid runtime policy");
  }
  const deployment = policyValue.deployment;
  const responseValue = await readJson(
    await fetch(new URL("/api/runtime-tokens", origin), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        allowedActions: stringArray(deployment.allowedActions, "allowedActions policy"),
        blockedActions: stringArray(deployment.blockedActions, "blockedActions policy"),
        allowedProxies: stringArray(deployment.allowedProxies, "allowedProxies policy"),
      }),
      signal: requestSignal(signal),
    }),
    "runtime token creation",
  );
  if (
    !isRecord(responseValue) ||
    typeof responseValue.token !== "string" ||
    !isRecord(responseValue.record) ||
    responseValue.record.name !== name
  ) {
    throw new Error("OpenConnector returned an invalid runtime token");
  }
  return responseValue.token;
}

function defaultEntry(url: string, token: string): McpServerConfig {
  return { url, headers: { Authorization: `Bearer ${token}` } };
}

function isDeclared(office: Office): boolean {
  const scopes = loadScopeMcpServers(office);
  return (
    Object.hasOwn(scopes.global, OPEN_CONNECTOR_SERVER) ||
    Object.hasOwn(scopes.conversation, OPEN_CONNECTOR_SERVER)
  );
}

/**
 * Fill in the deployment default for a Slack office that has not declared
 * `open-connector` anywhere. Writes the token as a conversation MCP entry;
 * throws when provisioning fails so the caller can report it. Any declared
 * entry (self-hosted, disabled, or global) is respected untouched.
 */
export async function ensureDefaultOpenConnector(
  office: Office,
  platformWorkspaceId: string | undefined,
  defaultServer: McpServerConfig | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const adminToken = readEnv("OPENCONNECTOR_ADMIN_TOKEN");
  if (!defaultServer?.url || !adminToken || office.address.platform !== "slack") return;
  if (!platformWorkspaceId) {
    log.logWarning(
      `[${office.address.conversationId}] OpenConnector default skipped`,
      "Slack workspace ID is unavailable",
    );
    return;
  }
  if (isDeclared(office)) return;

  const inflight = pending.get(office.stateDir);
  if (inflight) return inflight;
  const url = defaultServer.url;
  const task = (async () => {
    const name = `mikan:slack:${platformWorkspaceId}:${office.address.conversationId}`;
    const token = await createRuntimeToken(new URL(url).origin, adminToken, name, signal);
    // Re-read after the await: an operator may have declared the server meanwhile.
    if (isDeclared(office)) return;
    const current = loadScopeMcpServers(office).conversation;
    updateConversationSettings(office, {
      mcpServers: { ...current, [OPEN_CONNECTOR_SERVER]: defaultEntry(url, token) },
    });
    log.logInfo(`[${office.address.conversationId}] Provisioned default OpenConnector token`);
  })();
  pending.set(office.stateDir, task);
  try {
    await task;
  } finally {
    pending.delete(office.stateDir);
  }
}

export interface LegacyTokenMigrationReport {
  migrated: OfficeKey[];
  skipped: { key: OfficeKey; reason: string }[];
}

/**
 * One-time conversion of pre-existing `open-connector-runtime-token.json`
 * files into conversation `mcpServers` entries for `defaultUrl`. Files whose
 * token was minted for another origin, or whose office already declares the
 * server, are left in place and reported. Run with the daemon stopped.
 */
export function migrateLegacyOpenConnectorTokens(
  stateDir: string,
  defaultUrl: string,
  workspaceRoot = join(stateDir, "workspace"),
): LegacyTokenMigrationReport {
  const origin = new URL(defaultUrl).origin;
  const report: LegacyTokenMigrationReport = { migrated: [], skipped: [] };
  const conversationsDir = join(stateDir, "conversations");
  if (!existsSync(conversationsDir)) return report;
  const workspace = createWorkspace({ root: workspaceRoot, stateDir });
  const registered = new Map(
    listRegisteredOffices(stateDir).map((record) => [officeKey(record), record] as const),
  );
  for (const entry of readdirSync(conversationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isOfficeKey(entry.name)) continue;
    const key = entry.name;
    const legacyPath = join(conversationsDir, key, LEGACY_TOKEN_FILE);
    if (!existsSync(legacyPath)) continue;
    const record = registered.get(key);
    if (!record) {
      report.skipped.push({ key, reason: "office is not registered" });
      continue;
    }
    const office = workspace.office(record);
    if (isDeclared(office)) {
      report.skipped.push({ key, reason: `${OPEN_CONNECTOR_SERVER} is already declared` });
      continue;
    }
    let state;
    try {
      state = readJsonSchemaFileIfExists(
        legacyPath,
        LegacyTokenSchema,
        (detail) => `Malformed legacy token file: ${detail}`,
      );
    } catch (error) {
      report.skipped.push({ key, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!state) continue;
    if (state.origin !== origin) {
      report.skipped.push({ key, reason: `token origin ${state.origin} differs` });
      continue;
    }
    const current = loadScopeMcpServers(office).conversation;
    updateConversationSettings(office, {
      mcpServers: { ...current, [OPEN_CONNECTOR_SERVER]: defaultEntry(defaultUrl, state.token) },
    });
    rmSync(legacyPath);
    report.migrated.push(key);
  }
  return report;
}
