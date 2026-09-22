import * as undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
  const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
  if (normalizedTimeoutMs === undefined) {
    throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
  }

  undici.setGlobalDispatcher(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      bodyTimeout: normalizedTimeoutMs,
      headersTimeout: normalizedTimeoutMs,
    }),
  );

  const shouldInstallGlobals =
    installedGlobalFetch === undefined
      ? globalThis.fetch === originalGlobalFetch
      : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    (undici as { install?: () => void }).install?.();
    installedGlobalFetch = globalThis.fetch;
  }
}
