/**
 * Shared pieces of the CLI flag grammar.
 *
 * `resolveBoot` (cli/boot.ts) is the daemon's only full argv parser. This
 * module holds what other scanners must agree with it on: the value-flag
 * spelling (`--flag value` / `--flag=value`) via `takeValueFlag`, the default
 * state dir, and an early `--state-dir` probe for import-time consumers
 * (Sentry instrumentation) that must not load the boot path.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readEnv } from "../env-manifest.js";

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

/**
 * Effective state dir — the ONE place its precedence is decided:
 * `--state-dir` flag (last occurrence wins) > STATE_DIR / MIKAN_STATE_DIR
 * env > `~/.mikan`. Boot writes the resolved value back into the env
 * (setEnvAliases) purely as a compatibility channel for code that runs
 * without access to the boot plan — see `effectiveStateDir`.
 */
export function resolveStateDir(
  args: string[] = process.argv.slice(2),
  envValue: string | undefined = readEnv("STATE_DIR"),
): string {
  let flagValue: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const taken = takeValueFlag(args, i, "--state-dir");
    if (taken) {
      flagValue = taken.value;
      i = taken.lastIndex;
    }
  }
  if (flagValue !== undefined) return resolve(flagValue);
  if (envValue) return resolve(envValue);
  return defaultStateDir();
}

/**
 * State dir for post-boot readers: the env channel (which boot populated
 * from the resolved plan) with the shared default. Never re-reads argv —
 * by the time this runs, any `--state-dir` flag is already folded in.
 */
export function effectiveStateDir(): string {
  return resolveStateDir([]);
}
