/**
 * Boot resolution for the `mikan` binary: argv → a BootPlan saying which mode
 * to run and with what configuration. Pure — no side effects, no exits — so
 * the grammar that actually drives the daemon is testable without spawning a
 * process; main.ts just executes the plan.
 *
 * Modes, highest priority first: `office`, `sessions`, `env` (own grammars, never
 * flag-parsed here), `help`, `version`, `onboard`, `download`, `run`.
 */
import { join, resolve } from "node:path";
import { envSummaryLines } from "../env-manifest.js";
import { parseSandboxArg } from "../sandbox/index.js";
import type { BootPlan } from "./types.js";
import { type ArgScan, defaultStateDir, resolveStateDir, scanArgs } from "./arg-grammar.js";

export type { BootPlan } from "./types.js";

/** Subcommands that own their argv; boot only routes to them. */
const SUBCOMMANDS = ["office", "sessions", "env"] as const;

const BOOT_GRAMMAR = {
  values: ["--sandbox", "--state-dir", "--download"],
  flags: [["--help", "-h"], ["--version", "-v", "-V"], ["--onboard"]],
} as const;

export function resolveBoot(args: string[] = process.argv.slice(2)): BootPlan {
  const routed = subcommandPlan(args);
  if (routed) return routed;

  const scan = scanArgs(args, BOOT_GRAMMAR);
  if (scan.unknown) {
    throw new Error(`Unknown flag: ${scan.unknown}. Run \`mikan --help\` for usage.`);
  }

  // `onboard` counts as a subcommand only in first position; anywhere else it
  // is an ordinary working-directory positional.
  const onboardFirst = args[0] === "onboard";
  const workingDirArg = (onboardFirst ? scan.positionals.slice(1) : scan.positionals).at(-1);
  const downloadChannel = scan.values.get("--download");
  const sandboxArg = scan.values.get("--sandbox");
  const stateDir = resolveStateDir(args);
  return {
    mode: bootMode(scan, onboardFirst, downloadChannel),
    stateDir,
    workingDir: workingDirArg ? resolve(workingDirArg) : join(stateDir, "workspace"),
    workingDirExplicit: workingDirArg !== undefined,
    sandbox: sandboxArg === undefined ? { type: "host" } : parseSandboxArg(sandboxArg),
    downloadChannel,
  };
}

function subcommandPlan(args: string[]): BootPlan | undefined {
  const mode = SUBCOMMANDS.find((name) => name === args[0]);
  if (!mode) return undefined;
  const stateDir = defaultStateDir();
  return {
    mode,
    ...(mode === "office" ? { officeArgs: args.slice(1) } : {}),
    ...(mode === "sessions" ? { sessionsArgs: args.slice(1) } : {}),
    stateDir,
    workingDir: join(stateDir, "workspace"),
    workingDirExplicit: false,
    sandbox: { type: "host" },
  };
}

function bootMode(
  scan: ArgScan,
  onboardFirst: boolean,
  downloadChannel: string | undefined,
): BootPlan["mode"] {
  if (scan.flags.has("--help")) return "help";
  if (scan.flags.has("--version")) return "version";
  if (onboardFirst || scan.flags.has("--onboard")) return "onboard";
  if (downloadChannel) return "download";
  return "run";
}

export function helpText(): string {
  return `mikan — multi-platform chat agent daemon

Usage:
  mikan [options] [working-directory]
      Start the daemon. The working directory defaults to <state-dir>/workspace.
  mikan office <list|claim> …
      Inspect conversation offices and claim legacy directories for a platform.
  mikan sessions migrate …
      Migrate legacy v3 and Pi 0.84 session files to the current v4 format (stop the daemon first).
  mikan env
      Show the full environment-variable inventory and what is currently set.
  mikan onboard
      Interactive first-run setup: chat adapter, LLM provider, sandbox.
      Writes settings.json, ~/.mikan/mikan.env, and models.json as needed.

Options:
  --state-dir <dir>      State directory (settings.json, vaults, packages).
                         Default: ~/.mikan
  --sandbox <spec>       Execution sandbox. One of:
                           host
                           container:<existing-container-name>
                           image:<image[:tag]>
                           cloudflare:<sandbox-id>
                         Default: host
  --download <channel>   Dump a Slack channel's history (Slack only), then exit.
  --version, -v          Print the version.
  --help, -h             Show this help.

Environment (platform tokens select which chat adapters start):
${envSummaryLines().join("\n")}
Run \`mikan env\` for the full inventory.`;
}
