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
  if (arg === undefined) return undefined;
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
  const flagValue = scanArgs(args, { values: ["--state-dir"] }).values.get("--state-dir");
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

/** Flag/positional split of one argv, shared by every mikan CLI grammar. */
export interface ArgScan {
  /** Last value seen for each value flag, keyed by the flag name. */
  values: Map<string, string>;
  /** Canonical (first-listed) spelling of every boolean flag present. */
  flags: Set<string>;
  positionals: string[];
  /** First token that looked like a flag but matched no spec entry. */
  unknown?: string;
}

export interface ArgSpec {
  /** Value flags, in `--name value` / `--name=value` form. */
  values?: readonly string[];
  /** Boolean flags as alias groups; the first spelling is the canonical one. */
  flags?: readonly (readonly string[])[];
}

/**
 * Split `args` into value flags, boolean flags and positionals. Callers decide
 * what an unknown flag means — boot throws, the subcommands print usage — so
 * the scan only reports the first one it saw.
 */
export function scanArgs(args: string[], spec: ArgSpec = {}): ArgScan {
  const scan: ArgScan = { values: new Map(), flags: new Set(), positionals: [] };
  for (let i = 0; i < args.length; i++) {
    i = consumeArg(args, i, spec, scan);
  }
  return scan;
}

/** Report an unrecognized flag alongside the command's usage; yields its exit code. */
export function reportUnknownFlag(unknown: string, usage: string): number {
  console.error(`Unknown flag: ${unknown}\n${usage}`);
  return 1;
}

/** Fold `args[i]` into `scan`; returns the last argv index it consumed. */
function consumeArg(args: string[], i: number, spec: ArgSpec, scan: ArgScan): number {
  const arg = args[i];
  if (arg === undefined) return i;
  for (const name of spec.values ?? []) {
    const taken = takeValueFlag(args, i, name);
    if (!taken) continue;
    scan.values.set(name, taken.value);
    return taken.lastIndex;
  }
  const canonical = spec.flags?.find((aliases) => aliases.includes(arg))?.[0];
  if (canonical) scan.flags.add(canonical);
  else if (arg.startsWith("-")) scan.unknown ??= arg;
  else scan.positionals.push(arg);
  return i;
}
