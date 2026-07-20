import type { RuntimeShutdownOptions } from "./types.js";

/**
 * Preserve Gondolin coordinator ownership until every runtime control path and
 * telemetry flush has finished. A replacement coordinator must never overlap
 * the old gateway merely because application shutdown has started.
 */
export async function shutdownRuntime(options: RuntimeShutdownOptions): Promise<void> {
  await options.shutdownHandler();
  options.stopEvents();
  await options.disconnectGondolinRuntimes();
  await options.flushTelemetry();
  options.releaseGondolinCoordinator();
  options.exit(0);
}
