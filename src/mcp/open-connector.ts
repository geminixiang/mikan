import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Type, type Static } from "@sinclair/typebox";
import { join } from "node:path";
import { readEnv } from "../env-manifest.js";
import * as log from "../log.js";
import type { Office } from "../office/index.js";
import {
  atomicWritePrivateFile,
  ensureDirExists,
  isRecord,
  readJsonSchemaFileIfExists,
} from "../utils/file-guards.js";
import type { McpServerConfig } from "./types.js";

const OPEN_CONNECTOR_SERVER = "open-connector";
const TOKEN_STATE_FILE = "open-connector-runtime-token.json";
const REQUEST_TIMEOUT_MS = 10_000;
const pendingTokens = new Map<string, Promise<RuntimeTokenState>>();
const CONNECTION_AWARE_TOOLS = new Set(["get_action_guide", "execute_action"]);

const RuntimeTokenStateSchema = Type.Object(
  {
    version: Type.Literal(1),
    origin: Type.String(),
    name: Type.String(),
    id: Type.String(),
    token: Type.String(),
  },
  { additionalProperties: false },
);

type RuntimeTokenState = Static<typeof RuntimeTokenStateSchema>;

function readRuntimeTokenState(path: string) {
  return readJsonSchemaFileIfExists(
    path,
    RuntimeTokenStateSchema,
    (detail) => `Malformed OpenConnector runtime token state at ${path}: ${detail}`,
  );
}

function readUniqueConnectionName(result: unknown, service: string) {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  const text = result.content.find(
    (part): part is { type: "text"; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string",
  )?.text;
  if (!text) return undefined;
  try {
    const payload: unknown = JSON.parse(text);
    if (!isRecord(payload)) return undefined;
    const connections = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.connections)
        ? payload.connections
        : undefined;
    if (!connections) return undefined;
    const names = new Set(
      connections.flatMap((connection) =>
        isRecord(connection) &&
        connection.service === service &&
        typeof connection.connectionName === "string"
          ? [connection.connectionName]
          : [],
      ),
    );
    return names.size === 1 ? names.values().next().value : undefined;
  } catch {
    return undefined;
  }
}

/** Fill an omitted connection only when OpenConnector reports exactly one
 * candidate for the action's service. Multiple-account selection remains an
 * explicit agent decision. */
export async function prepareOpenConnectorToolArguments(
  client: Pick<Client, "callTool">,
  serverName: string,
  toolName: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (
    serverName !== OPEN_CONNECTOR_SERVER ||
    !CONNECTION_AWARE_TOOLS.has(toolName) ||
    typeof params.connectionName === "string" ||
    typeof params.actionId !== "string"
  ) {
    return params;
  }
  const service = params.actionId.split(".", 1)[0];
  if (!service) return params;
  const result = await client.callTool(
    { name: "list_connections", arguments: { service } },
    undefined,
    { timeout: REQUEST_TIMEOUT_MS, ...(signal ? { signal } : {}) },
  );
  const connectionName = readUniqueConnectionName(result, service);
  return connectionName ? { ...params, connectionName } : params;
}

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
  signal?: AbortSignal,
): Promise<RuntimeTokenState> {
  const headers = { Authorization: `Bearer ${adminToken}` };
  const policyValue = await readJson(
    await fetch(new URL("/api/runtime-policy", origin), {
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
    !responseValue.token.startsWith("oct_") ||
    !isRecord(responseValue.record) ||
    typeof responseValue.record.id !== "string" ||
    responseValue.record.name !== name
  ) {
    throw new Error("OpenConnector returned an invalid runtime token");
  }
  return {
    version: 1,
    origin,
    name,
    id: responseValue.record.id,
    token: responseValue.token,
  };
}

function disabledServer(
  servers: Record<string, McpServerConfig>,
  config: McpServerConfig,
): Record<string, McpServerConfig> {
  return { ...servers, [OPEN_CONNECTOR_SERVER]: { ...config, disabled: true } };
}

async function loadOrCreateRuntimeToken(
  office: Office,
  origin: string,
  adminToken: string,
  name: string,
  signal?: AbortSignal,
): Promise<RuntimeTokenState> {
  const statePath = join(office.stateDir, TOKEN_STATE_FILE);
  const state = readRuntimeTokenState(statePath);
  if (state) {
    if (state.origin !== origin || state.name !== name) {
      throw new Error(`OpenConnector runtime token state does not match ${name}`);
    }
    return state;
  }

  const key = `${origin}:${office.key}`;
  const pending = pendingTokens.get(key);
  if (pending) return pending;

  const creation = (async () => {
    const current = readRuntimeTokenState(statePath);
    if (current) return current;
    const created = await createRuntimeToken(origin, adminToken, name, signal);
    ensureDirExists(office.stateDir);
    atomicWritePrivateFile(statePath, `${JSON.stringify(created, null, 2)}\n`);
    log.logInfo(
      `[${office.address.conversationId}] Created OpenConnector runtime token ${created.id}`,
    );
    return created;
  })();
  pendingTokens.set(key, creation);
  try {
    return await creation;
  } finally {
    pendingTokens.delete(key);
  }
}

/**
 * Replace the deployment-wide OpenConnector bearer token with one scoped to
 * this Slack Conversation office. The privileged admin token is read only at
 * this host boundary and is never written into settings, Vault, or a sandbox.
 */
export async function provisionOfficeOpenConnectorToken(
  office: Office,
  platformWorkspaceId: string | undefined,
  servers: Record<string, McpServerConfig> | undefined,
  signal?: AbortSignal,
): Promise<Record<string, McpServerConfig> | undefined> {
  const config = servers?.[OPEN_CONNECTOR_SERVER];
  const adminToken = readEnv("OPENCONNECTOR_ADMIN_TOKEN");
  if (!config || config.disabled || !adminToken || office.address.platform !== "slack") {
    return servers;
  }
  const configuredOrigin = readEnv("OPENCONNECTOR_ORIGIN");
  if (!configuredOrigin || !URL.canParse(configuredOrigin)) {
    log.logWarning(
      `[${office.address.conversationId}] OpenConnector token provisioning skipped`,
      "OPENCONNECTOR_ORIGIN is missing or invalid",
    );
    return disabledServer(servers, config);
  }
  if (!platformWorkspaceId) {
    log.logWarning(
      `[${office.address.conversationId}] OpenConnector token provisioning skipped`,
      "Slack workspace ID is unavailable",
    );
    return disabledServer(servers, config);
  }
  if (!config.url) {
    log.logWarning(
      `[${office.address.conversationId}] OpenConnector token provisioning skipped`,
      "the open-connector server is not configured for HTTP",
    );
    return disabledServer(servers, config);
  }

  try {
    const endpoint = new URL(config.url);
    const origin = new URL(configuredOrigin).origin;
    if (endpoint.origin !== origin) {
      throw new Error("the MCP endpoint does not match the deployment-owned OpenConnector origin");
    }
    const name = `mikan:slack:${platformWorkspaceId}:${office.address.conversationId}`;
    const state = await loadOrCreateRuntimeToken(office, origin, adminToken, name, signal);
    return {
      ...servers,
      [OPEN_CONNECTOR_SERVER]: {
        ...config,
        headers: { ...config.headers, Authorization: `Bearer ${state.token}` },
      },
    };
  } catch (error) {
    log.logWarning(
      `[${office.address.conversationId}] OpenConnector token provisioning failed`,
      error instanceof Error ? error.message : String(error),
    );
    return disabledServer(servers, config);
  }
}
