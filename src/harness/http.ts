/**
 * Global HTTP dispatcher configuration for the mikan harness.
 *
 * mikan is a long-running headless process whose LLM traffic goes through
 * global `fetch`. Node's built-in fetch ignores `HTTP_PROXY`/`HTTPS_PROXY`/
 * `NO_PROXY` and offers no idle-timeout control, so a proxied deployment
 * cannot reach providers and a silently stalled streaming response would
 * hang a session without ever erroring (auto-retry never kicks in).
 *
 * `configureHttpDispatcher` installs undici's `EnvHttpProxyAgent` as the
 * global dispatcher (proxy support via the standard env vars) with
 * headers/body idle timeouts, and swaps global `fetch` to undici's so both
 * share one implementation. A caller that deliberately replaced `fetch`
 * after module load is left alone.
 *
 * Design adapted from pi-coding-agent's http-dispatcher.
 */
import * as undici from "undici";

/** Idle timeout applied to HTTP headers/body when none is configured. */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

/**
 * Parse an idle-timeout setting into milliseconds.
 *
 * Accepts a non-negative number of milliseconds or its string form;
 * `"disabled"` (case-insensitive) yields `0`. Returns `undefined` for
 * anything unparseable so callers can fall back to the default.
 */
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

/**
 * Install the global HTTP dispatcher and fetch. A timeout of `0` disables
 * idle timeouts. Safe to call more than once; the last call wins.
 */
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

  // Node's built-in fetch uses its own bundled undici and never sees the
  // dispatcher installed above, so global fetch must be swapped to undici's.
  const shouldInstallGlobals =
    installedGlobalFetch === undefined
      ? globalThis.fetch === originalGlobalFetch
      : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install?.();
    installedGlobalFetch = globalThis.fetch;
  }
}
