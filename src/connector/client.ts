import { readBoundedResponseText } from "../web/oauth-flow.js";
import { isRecord } from "../utils/file-guards.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const ALIAS_HEADER = "x-oo-connector-alias";

/** Failure surfaced by the Open Connector service or by transport. */
export class ConnectorError extends Error {
  constructor(
    /** Machine-readable category: connector error codes plus mikan-side
     *  `transport_error`, `invalid_response`, `not_configured`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

/** One configured connection as reported by `GET /api/connections`. */
export interface ConnectorConnectionSummary {
  service: string;
  connectionName: string;
  configured: boolean;
}

export interface OpenConnectorClientOptions {
  /** Base URL of the self-hosted Open Connector service, no trailing slash. */
  baseUrl: string;
  /** Runtime token for `/v1` action execution. */
  runtimeToken?: string;
  /** Admin token for `/api` onboarding and connection management. */
  adminToken?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * Minimal HTTP client for a self-hosted Open Connector deployment.
 *
 * Two token scopes mirror the service's auth model: the runtime token may
 * only execute actions (`/v1`); the admin token drives OAuth onboarding and
 * connection management (`/api`). Neither token, and no provider credential,
 * ever leaves the host process — callers receive action results only.
 */
export class OpenConnectorClient {
  private readonly baseUrl: string;
  private readonly runtimeToken?: string;
  private readonly adminToken?: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenConnectorClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.runtimeToken = options.runtimeToken;
    this.adminToken = options.adminToken;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** Execute a connector action against a named connection; returns `data`. */
  async executeAction(
    actionId: string,
    input: Record<string, unknown>,
    connectionName: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.runtimeToken) {
      throw new ConnectorError("not_configured", "Connector runtime token is not configured");
    }
    const body = await this.request(`/v1/actions/${encodeURIComponent(actionId)}`, {
      method: "POST",
      token: this.runtimeToken,
      headers: { [ALIAS_HEADER]: connectionName },
      body: { input },
      signal,
    });
    if (body.success !== true) {
      throw new ConnectorError(
        typeof body.error === "string" ? body.error : "action_failed",
        typeof body.message === "string" ? body.message : `Connector action ${actionId} failed`,
      );
    }
    return body.data;
  }

  /** Start an OAuth authorization; returns the URL the user must open. */
  async createAuthorization(
    service: string,
    connectionName: string,
  ): Promise<{ authorizationUrl: string }> {
    const body = await this.request("/api/oauth/authorizations", {
      method: "POST",
      token: this.requireAdminToken(),
      body: { service, connectionName },
    });
    if (typeof body.authorizationUrl !== "string" || !body.authorizationUrl) {
      throw new ConnectorError("invalid_response", "Connector returned no authorizationUrl");
    }
    return { authorizationUrl: body.authorizationUrl };
  }

  /** List all configured connections. */
  async listConnections(): Promise<ConnectorConnectionSummary[]> {
    const body = await this.requestRaw("/api/connections", {
      method: "GET",
      token: this.requireAdminToken(),
    });
    if (!Array.isArray(body)) {
      throw new ConnectorError("invalid_response", "Connector connection list is not an array");
    }
    return body.filter(isRecord).map((entry) => ({
      service: typeof entry.service === "string" ? entry.service : "",
      connectionName: typeof entry.connectionName === "string" ? entry.connectionName : "",
      configured: entry.configured === true,
    }));
  }

  /** Delete a named connection's stored credential on the connector. */
  async deleteConnection(service: string, connectionName: string): Promise<void> {
    await this.request(
      `/api/connections/${encodeURIComponent(service)}?connectionName=${encodeURIComponent(connectionName)}`,
      { method: "DELETE", token: this.requireAdminToken() },
    );
  }

  private requireAdminToken(): string {
    if (!this.adminToken) {
      throw new ConnectorError("not_configured", "Connector admin token is not configured");
    }
    return this.adminToken;
  }

  private async request(
    path: string,
    options: {
      method: string;
      token: string;
      headers?: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
    },
  ): Promise<Record<string, unknown>> {
    const parsed = await this.requestRaw(path, options);
    if (!isRecord(parsed)) {
      throw new ConnectorError("invalid_response", "Connector response is not a JSON object");
    }
    return parsed;
  }

  private async requestRaw(
    path: string,
    options: {
      method: string;
      token: string;
      headers?: Record<string, string>;
      body?: unknown;
      signal?: AbortSignal;
    },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: {
          Authorization: `Bearer ${options.token}`,
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal ?? null,
      });
    } catch (err) {
      if (options.signal?.aborted) throw new ConnectorError("aborted", "Connector call aborted");
      const detail = err instanceof Error ? err.message : String(err);
      throw new ConnectorError("transport_error", `Connector unreachable: ${detail}`);
    }

    const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ConnectorError(
        "invalid_response",
        `Connector returned non-JSON (HTTP ${response.status})`,
      );
    }
    if (!response.ok) {
      const record = isRecord(parsed) ? parsed : {};
      // Admin APIs wrap failures as `{error: {code, message}}`; runtime
      // responses may carry flat `message`/`success` fields instead.
      const errorRecord = isRecord(record.error) ? record.error : record;
      const code =
        typeof errorRecord.code === "string"
          ? errorRecord.code
          : typeof record.error === "string"
            ? record.error
            : `http_${response.status}`;
      const message =
        typeof errorRecord.message === "string"
          ? errorRecord.message
          : typeof record.message === "string"
            ? record.message
            : `Connector request failed (HTTP ${response.status})`;
      throw new ConnectorError(code, message);
    }
    return parsed;
  }
}
