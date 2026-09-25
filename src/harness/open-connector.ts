import { Type } from "typebox";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readEnv } from "../env-manifest.js";
import * as log from "../log.js";
import { loadScopeMcpServers, updateConversationSettings } from "../settings/index.js";
import { readJsonSchemaFileIfExists } from "../file-guards.js";
import { createWorkspace, isOfficeKey, listRegisteredOffices, officeKey } from "../office/index.js";
import type { Office } from "../office/types.js";
import type { OfficeKey } from "../types.js";
import type { EnsureDefaultOpenConnectorOptions, McpServerConfig } from "./types.js";
import { errorMessage, isRecord } from "../unknown-values.js";

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

async function createRuntimeToken(
  origin: string,
  adminToken: string,
  name: string,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<string> {
  const headers = { Authorization: `Bearer ${adminToken}` };
  const policyValue = await readJson(
    await fetchFn(new URL("/api/runtime-policy", origin), {
      headers,
      signal: requestSignal(signal),
    }),
    "runtime policy request",
  );
  if (!isRecord(policyValue) || !isRecord(policyValue.deployment)) {
    throw new Error("OpenConnector returned an invalid runtime policy");
  }
  const deployment = policyValue.deployment;
  const responseValue = await readJson(
    await fetchFn(new URL("/api/runtime-tokens", origin), {
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

export async function ensureDefaultOpenConnector({
  office,
  platformWorkspaceId,
  defaultServer,
  signal,
  fetch: fetchFn = globalThis.fetch,
}: EnsureDefaultOpenConnectorOptions): Promise<void> {
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
    const token = await createRuntimeToken(new URL(url).origin, adminToken, name, fetchFn, signal);
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
      report.skipped.push({ key, reason: errorMessage(error) });
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
