import { readEnv } from "../env-manifest.js";
import * as log from "../log.js";
import { loadScopeMcpServers, updateConversationSettings } from "../settings/index.js";
import type { Office } from "../office/types.js";
import type { EnsureDefaultOpenConnectorOptions, McpServerConfig } from "./types.js";
import { isRecord } from "../unknown-values.js";

const OPEN_CONNECTOR_SERVER = "open-connector";
const REQUEST_TIMEOUT_MS = 10_000;
const pending = new Map<string, Promise<void>>();

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

function runtimeTokenName(office: Office, platformWorkspaceId?: string): string | undefined {
  const { platform, conversationId } = office.address;
  if (platform === "github") return `mikan:github:${conversationId}`;
  if (platform !== "slack") return undefined;
  if (platformWorkspaceId) return `mikan:slack:${platformWorkspaceId}:${conversationId}`;
  log.logWarning(
    `[${conversationId}] OpenConnector default skipped`,
    "Slack workspace ID is unavailable",
  );
  return undefined;
}

export async function ensureDefaultOpenConnector({
  office,
  platformWorkspaceId,
  defaultServer,
  signal,
  fetch: fetchFn = globalThis.fetch,
}: EnsureDefaultOpenConnectorOptions): Promise<void> {
  const adminToken = readEnv("OPENCONNECTOR_ADMIN_TOKEN");
  if (!defaultServer?.url || !adminToken) return;
  const name = runtimeTokenName(office, platformWorkspaceId);
  if (!name || isDeclared(office)) return;

  const inflight = pending.get(office.stateDir);
  if (inflight) return inflight;
  const url = defaultServer.url;
  const task = (async () => {
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
