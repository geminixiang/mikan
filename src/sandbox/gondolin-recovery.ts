/**
 * The single home of gondolin's crash-recovery vocabulary. Every transport
 * classifies failures with these errors, and every policy site decides
 * through the named predicates — the story reads in one place:
 *
 * - **Gone** (isRuntimeGone): the command never reached the runtime — the
 *   session socket refused, the lease lapsed, or the hosting worker vanished.
 *   Safe to recreate the runtime and retry; `withRuntime` (gondolin.ts)
 *   retries exactly once.
 * - **Interrupted** (isRuntimeInterrupted): the runtime died (or went silent
 *   past the idle deadline) with the command in flight. Side effects may have
 *   landed, so the failure must surface; the session is discarded only when
 *   the runtime is confirmed dead.
 * - **Lease-fenced** (isLeaseFencedStatus): the remote daemon rejected our
 *   lease — a newer epoch superseded it (409) or it expired (410). The cached
 *   lease is dropped and re-acquired once; the fleet's failover gate
 *   (assertFailoverAllowed) separately keeps a replacement placement fenced
 *   until the old lease's watermark passes.
 */

/**
 * The runtime is gone and the command never reached it (the session socket
 * refused the connection) — safe to recreate the runtime and retry.
 */
export class GondolinRuntimeGoneError extends Error {}

/** The runtime died with the command in flight — not safe to retry blindly. */
export class GondolinRuntimeInterruptedError extends Error {}

export function isRuntimeGone(error: unknown): error is GondolinRuntimeGoneError {
  return error instanceof GondolinRuntimeGoneError;
}

export function isRuntimeInterrupted(error: unknown): error is GondolinRuntimeInterruptedError {
  return error instanceof GondolinRuntimeInterruptedError;
}

/** 409 = a newer lease epoch superseded ours; 410 = our lease expired. */
export function isLeaseFencedStatus(status: number | undefined): boolean {
  return status === 409 || status === 410;
}
