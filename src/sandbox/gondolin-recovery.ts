/**
 * Crash-recovery vocabulary for a local detached Gondolin worker.
 *
 * - **Gone**: the command never reached the runtime because its session socket
 *   refused the connection. Recreating the runtime and retrying is safe.
 * - **Interrupted**: the runtime died or went silent with a command in flight.
 *   Side effects may have landed, so the failure must surface.
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
