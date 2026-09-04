interface ProcessShutdownOptions {
  stop: () => Promise<void>;
  flush: () => Promise<boolean>;
  captureError: (error: Error) => void;
  warn: (message: string, details?: string) => void;
  exit: (code: number) => void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Run every shutdown phase in order without letting one failure skip the rest. */
export async function runShutdownSteps(
  steps: readonly { name: string; run: () => Promise<void> }[],
): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      const failure = asError(error);
      failures.push(new Error(`${step.name}: ${failure.message}`, { cause: failure }));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Graceful shutdown failed");
}

/**
 * Owns process-signal shutdown policy: one graceful attempt, then a forced
 * non-zero exit when another signal says the operator no longer wants to wait.
 */
export function createProcessShutdownHandler(
  options: ProcessShutdownOptions,
): (signal: NodeJS.Signals) => Promise<void> {
  let shutdown: Promise<void> | undefined;
  let forced = false;

  return function handleSignal(signal: NodeJS.Signals): Promise<void> {
    if (shutdown) {
      forced = true;
      options.warn(`Received ${signal} during shutdown; forcing exit`);
      options.exit(1);
      return Promise.resolve();
    }

    shutdown = (async () => {
      let exitCode = 0;
      try {
        await options.stop();
      } catch (error) {
        const failure = asError(error);
        exitCode = 1;
        options.warn("Graceful shutdown failed", failure.message);
        options.captureError(failure);
      }

      try {
        if (!(await options.flush())) {
          exitCode = 1;
          options.warn("Sentry flush timed out during shutdown");
        }
      } catch (error) {
        exitCode = 1;
        options.warn("Sentry flush failed during shutdown", asError(error).message);
      }

      if (!forced) options.exit(exitCode);
    })();
    return shutdown;
  };
}
