import { createHash } from "node:crypto";
import { ConnectorError, type OpenConnectorClient } from "./client.js";
import type { ConnectorConnectionStore } from "./store.js";

/** Connector services mikan onboards; each is its own OAuth connection. */
const CONNECTOR_SERVICES = [
  { service: "gmail", label: "Gmail" },
  { service: "googlecalendar", label: "Google Calendar" },
  { service: "googlesheets", label: "Google Sheets" },
  { service: "github", label: "GitHub (personal)" },
] as const;

export type ConnectorService = (typeof CONNECTOR_SERVICES)[number]["service"];

/**
 * The reviewed action allowlist: every tool-visible action maps to exactly
 * one connector actionId, and nothing outside this table is executable —
 * the runtime token's grants should mirror it. Read-only by design for the
 * first deployment; the raw connector proxy is never called.
 */
export const CURATED_ACTIONS = {
  gmail_search: { service: "gmail", actionId: "gmail.search_threads" },
  gmail_read_thread: { service: "gmail", actionId: "gmail.fetch_message_by_thread_id" },
  calendar_list_events: { service: "googlecalendar", actionId: "googlecalendar.list_events" },
  sheets_read_range: { service: "googlesheets", actionId: "googlesheets.values_get" },
  github_whoami: { service: "github", actionId: "github.get_current_user" },
  github_my_repositories: { service: "github", actionId: "github.list_my_repositories" },
} as const satisfies Record<string, { service: ConnectorService; actionId: string }>;

export type CuratedActionName = keyof typeof CURATED_ACTIONS;

const MAX_RESULT_CHARS = 40_000;

export interface ConnectorGatewayOptions {
  client: OpenConnectorClient;
  store: ConnectorConnectionStore;
}

export interface ConnectorServiceStatus {
  service: ConnectorService;
  label: string;
  connected: boolean;
}

/**
 * Host-side seam between mikan and a self-hosted Open Connector deployment.
 *
 * Authorization stays mikan's: a caller identifies a principal by its
 * credential authorization key, and the gateway resolves that principal's
 * own connection name — never one supplied by the model. Provider tokens
 * live in the connector; the guest sees action results only.
 */
export class ConnectorGateway {
  private readonly client: OpenConnectorClient;
  private readonly store: ConnectorConnectionStore;

  constructor(options: ConnectorGatewayOptions) {
    this.client = options.client;
    this.store = options.store;
  }

  /** Execute a curated action as the given principal; returns rendered JSON. */
  async execute(
    principalKey: string,
    action: CuratedActionName,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string> {
    const curated = CURATED_ACTIONS[action];
    const connection = this.store.get(principalKey, curated.service);
    if (!connection) {
      throw new ConnectorError(
        "not_connected",
        `No ${curated.service} connection for this conversation. ` +
          `Run /login and open the connector page to authorize one.`,
      );
    }
    const data = await this.client.executeAction(
      curated.actionId,
      input,
      connection.connectionName,
      signal,
    );
    const rendered = JSON.stringify(data, null, 2) ?? "null";
    return rendered.length > MAX_RESULT_CHARS
      ? `${rendered.slice(0, MAX_RESULT_CHARS)}\n… (truncated, ${rendered.length} chars total)`
      : rendered;
  }

  /** Per-service connection status for a principal (from the local mapping). */
  status(principalKey: string): ConnectorServiceStatus[] {
    const connections = this.store.list(principalKey);
    return CONNECTOR_SERVICES.map(({ service, label }) => ({
      service,
      label,
      connected: Boolean(connections[service]),
    }));
  }

  /** Start OAuth onboarding; the caller sends the user to the returned URL. */
  async startOnboarding(
    principalKey: string,
    service: ConnectorService,
  ): Promise<{ authorizationUrl: string }> {
    return this.client.createAuthorization(service, connectionNameFor(principalKey, service));
  }

  /**
   * Check whether the principal's connection for a service now exists on the
   * connector; persist the mapping on first sight. `newly` is true only for
   * the poll that persisted the mapping, so callers notify exactly once.
   */
  async completeOnboarding(
    principalKey: string,
    service: ConnectorService,
  ): Promise<{ connected: boolean; newly: boolean }> {
    if (this.store.get(principalKey, service)) return { connected: true, newly: false };
    const connectionName = connectionNameFor(principalKey, service);
    const connections = await this.client.listConnections();
    const match = connections.find(
      (entry) =>
        entry.service === service && entry.connectionName === connectionName && entry.configured,
    );
    if (!match) return { connected: false, newly: false };
    this.store.set(principalKey, service, {
      connectionName,
      connectedAt: new Date().toISOString(),
    });
    return { connected: true, newly: true };
  }

  /** Remove the mapping and the connector-side credential. */
  async disconnect(principalKey: string, service: ConnectorService): Promise<void> {
    const connection = this.store.get(principalKey, service);
    if (connection) {
      await this.client.deleteConnection(service, connection.connectionName);
    }
    this.store.delete(principalKey, service);
  }
}

export function isConnectorService(value: string): value is ConnectorService {
  return CONNECTOR_SERVICES.some((entry) => entry.service === value);
}

/**
 * Deterministic per-(principal, service) connection name. Hashed: connector
 * names are capped at 64 chars and principal keys are host identifiers that
 * should not be advertised to the connector deployment.
 */
export function connectionNameFor(principalKey: string, service: ConnectorService): string {
  const hash = createHash("sha256")
    .update(`${principalKey}\0${service}`)
    .digest("hex")
    .slice(0, 16);
  return `mikan-${service}-${hash}`;
}
