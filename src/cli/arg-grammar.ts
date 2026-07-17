/**
 * Shared pieces of the CLI flag grammar.
 *
 * `resolveBoot` (cli/boot.ts) is the daemon's only full argv parser. This
 * module holds what other scanners must agree with it on: the value-flag
 * spelling (`--flag value` / `--flag=value`) via `takeValueFlag`, the default
 * state dir, and an early `--state-dir` probe for import-time consumers
 * (Sentry instrumentation) that must not load the boot path.
 */
import { homedir } from "os";
import { join, resolve } from "path";

export function defaultStateDir(): string {
  return join(homedir(), ".mikan");
}

/**
 * Match `args[i]` against a value flag, accepting both `--name value` and
 * `--name=value`. Returns the raw value and the index of the last argv slot
 * consumed, or undefined when `args[i]` is not this flag.
 */
export function takeValueFlag(
  args: string[],
  i: number,
  name: string,
): { value: string; lastIndex: number } | undefined {
  const arg = args[i];
  if (arg === name) return { value: args[i + 1] ?? "", lastIndex: i + 1 };
  if (arg.startsWith(name + "=")) return { value: arg.slice(name.length + 1), lastIndex: i };
  return undefined;
}

/** Early probe: resolve `--state-dir` from argv without the full parser. */
export function resolveStateDirFromArgv(args: string[] = process.argv.slice(2)): string {
  for (let i = 0; i < args.length; i++) {
    const taken = takeValueFlag(args, i, "--state-dir");
    if (taken) return resolve(taken.value);
  }
  return defaultStateDir();
}
