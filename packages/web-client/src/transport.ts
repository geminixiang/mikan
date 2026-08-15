import type {
  HarnessBootstrap,
  HarnessCommand,
  HarnessCommandResult,
  HarnessErrorBody,
  HarnessEventEnvelope,
} from "@geminixiang/mikan-harness-web-contract";
import type { HarnessConnectionStatus, HarnessHostPort } from "./types.js";

export class HarnessApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HarnessApiError";
  }
}

export class HttpHarnessHostPort implements HarnessHostPort {
  bootstrap(officeKey?: string): Promise<HarnessBootstrap> {
    const query = officeKey ? `?office=${encodeURIComponent(officeKey)}` : "";
    return requestJson<HarnessBootstrap>(`/api/harness/bootstrap${query}`);
  }

  async execute(command: HarnessCommand): Promise<HarnessCommandResult> {
    const request = (): Promise<HarnessCommandResult> =>
      requestJson<HarnessCommandResult>("/api/harness/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
    try {
      return await request();
    } catch (error) {
      // Commands are idempotent by principal + commandId. Retry only transport
      // failures so an accepted command whose response was lost can recover.
      if (error instanceof HarnessApiError) throw error;
      return request();
    }
  }

  subscribe(
    cursor: HarnessBootstrap["cursor"],
    onEvent: (event: HarnessEventEnvelope) => void,
    onReset: () => void,
    onConnection: (status: HarnessConnectionStatus) => void,
  ): () => void {
    const query = new URLSearchParams({
      epoch: cursor.epoch,
      after: String(cursor.sequence),
    });
    const source = new EventSource(`/api/harness/events?${query}`);
    source.addEventListener("open", () => onConnection("connected"));
    source.addEventListener("error", () => {
      onConnection("reconnecting");
      // EventSource keeps CONNECTING for transient network loss. A terminal
      // HTTP failure (for example an expired cookie) closes it permanently;
      // bootstrap again so the client can enter unauthenticated state.
      if (source.readyState === EventSource.CLOSED) onReset();
    });
    source.addEventListener("message", (event) => {
      try {
        onEvent(JSON.parse(event.data) as HarnessEventEnvelope);
      } catch {
        onReset();
      }
    });
    source.addEventListener("reset", onReset);
    return () => source.close();
  }

  async logout(): Promise<void> {
    const response = await fetch("/api/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw await apiError(response);
  }
}

export async function beginGitHubLogin(): Promise<void> {
  const body = await requestJson<{ ok: boolean; redirectUrl?: string; error?: string }>(
    "/api/oauth/start",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "login", serviceId: "github", mode: "login" }),
    },
  );
  if (!body.ok || !body.redirectUrl) {
    throw new Error(body.error || "GitHub login could not be started");
  }
  window.location.assign(body.redirectUrl);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...init?.headers },
  });
  if (!response.ok) throw await apiError(response);
  return (await response.json()) as T;
}

async function apiError(response: Response): Promise<HarnessApiError> {
  const body = (await response.json().catch(() => undefined)) as
    | HarnessErrorBody
    | { error?: string }
    | undefined;
  const nested = body && typeof body.error === "object" ? body.error.message : undefined;
  const flat = body && typeof body.error === "string" ? body.error : undefined;
  return new HarnessApiError(
    response.status,
    nested || flat || `Request failed (${response.status})`,
  );
}
