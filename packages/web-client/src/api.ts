/**
 * Thin fetch helpers for the mikan web API. Tokens travel in the URL
 * (deep-link `?token=…`), matching the existing portal token model.
 */

export interface ApiErrorBody {
  error?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Read one query parameter from the current URL. */
export function queryParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

/** GET a JSON endpoint. Throws ApiError on non-2xx. */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

/** POST a JSON body to an endpoint. Throws ApiError on non-2xx. */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as ApiErrorBody;
    throw new ApiError(res.status, parsed.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}
