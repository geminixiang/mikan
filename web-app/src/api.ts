import type { WebAccount, WebIdentityProvider } from "../../src/web/auth/types.js";
import type {
  WebPromptAccepted,
  WebSessionHistory,
  WebSessionSummary,
  WebStreamFrame,
  WebWorkspace,
} from "../../src/web/harness/protocol.js";

export interface WebSessionIdentity {
  readonly account: WebAccount;
  readonly csrfToken: string;
  readonly expiresAt: number;
}

export interface PromptInput {
  readonly text: string;
  readonly clientRequestId: string;
  readonly mode: "prompt" | "followUp" | "steer";
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class WebApi {
  private csrfToken: string | null = null;

  setSession(session: WebSessionIdentity | null): void {
    this.csrfToken = session?.csrfToken ?? null;
  }

  async loadSession(): Promise<WebSessionIdentity | null> {
    const response = await fetch("/api/web/me", { credentials: "same-origin" });
    if (response.status === 401) return null;
    return readJson<WebSessionIdentity>(response);
  }

  async loadProviders(): Promise<readonly WebIdentityProvider[]> {
    const value = await getJson<{ providers: WebIdentityProvider[] }>("/auth/providers");
    return value.providers;
  }

  async listWorkspaces(): Promise<readonly WebWorkspace[]> {
    const value = await getJson<{ workspaces: WebWorkspace[] }>("/api/web/workspaces");
    return value.workspaces;
  }

  async createWorkspace(name: string): Promise<WebWorkspace> {
    const value = await this.mutate<{ workspace: WebWorkspace }>("/api/web/workspaces", "POST", {
      name,
    });
    return value.workspace;
  }

  async renameWorkspace(workspaceId: string, name: string): Promise<WebWorkspace> {
    const value = await this.mutate<{ workspace: WebWorkspace }>(
      workspaceUrl(workspaceId),
      "PATCH",
      { name },
    );
    return value.workspace;
  }

  async listSessions(workspaceId: string): Promise<readonly WebSessionSummary[]> {
    const value = await getJson<{ sessions: WebSessionSummary[] }>(
      `${workspaceUrl(workspaceId)}/sessions`,
    );
    return value.sessions;
  }

  async loadHistory(workspaceId: string, sessionId?: string): Promise<WebSessionHistory | null> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const response = await fetch(`${workspaceUrl(workspaceId)}/history${query}`, {
      credentials: "same-origin",
    });
    if (response.status === 404 && !sessionId) return null;
    const value = await readJson<{ session: WebSessionHistory }>(response);
    return value.session;
  }

  prompt(workspaceId: string, input: PromptInput): Promise<WebPromptAccepted> {
    return this.mutate<WebPromptAccepted>(`${workspaceUrl(workspaceId)}/prompt`, "POST", input);
  }

  cancel(workspaceId: string): Promise<{ status: "stopping" | "idle" }> {
    return this.mutate(`${workspaceUrl(workspaceId)}/cancel`, "POST", {});
  }

  async logout(): Promise<void> {
    await this.mutate<unknown>("/api/web/logout", "POST", {});
    this.csrfToken = null;
  }

  stream(workspaceId: string, onFrame: (frame: WebStreamFrame) => void): EventSource {
    const stream = new EventSource(`${workspaceUrl(workspaceId)}/stream`);
    stream.addEventListener("message", (event) => {
      const frame = parseStreamFrame(event.data);
      if (frame) onFrame(frame);
    });
    return stream;
  }

  private async mutate<T>(path: string, method: "PATCH" | "POST", body: unknown): Promise<T> {
    if (!this.csrfToken) throw new ApiError("Your session has expired.", 401);
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Mikan-CSRF": this.csrfToken,
      },
      body: JSON.stringify(body),
    });
    return readJson<T>(response);
  }
}

async function getJson<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(path, { credentials: "same-origin" }));
}

async function readJson<T>(response: Response): Promise<T> {
  const value = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message = readErrorMessage(value) ?? `Request failed (HTTP ${response.status})`;
    throw new ApiError(message, response.status);
  }
  return value as T;
}

function readErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("error" in value)) return null;
  return typeof value.error === "string" ? value.error : null;
}

function parseStreamFrame(data: string): WebStreamFrame | null {
  try {
    const value = JSON.parse(data) as unknown;
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    return typeof value.type === "string" ? (value as WebStreamFrame) : null;
  } catch {
    return null;
  }
}

function workspaceUrl(workspaceId: string): string {
  return `/api/web/workspaces/${encodeURIComponent(workspaceId)}`;
}
