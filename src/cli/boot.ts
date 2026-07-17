/**
 * Boot resolution for the `mikan` binary: argv → a BootPlan saying which mode
 * to run and with what configuration. Pure — no side effects, no exits — so
 * the grammar that actually drives the daemon is testable without spawning a
 * process; main.ts just executes the plan.
 *
 * Modes, highest priority first: `ext` (own grammar, never flag-parsed here),
 * `help`, `version`, `worker-token`, `onboard`, `download`, `run`.
 */
import { join, resolve } from "path";
import { parseSandboxArg, type SandboxConfig } from "../sandbox/index.js";
import { defaultStateDir, takeValueFlag } from "./arg-grammar.js";

export interface BootPlan {
  mode: "ext" | "help" | "version" | "worker-token" | "onboard" | "download" | "run";
  /** argv after `ext`, handed to runExtCommand. Only set for mode "ext". */
  extArgs?: string[];
  stateDir: string;
  /** Resolved working directory; defaults to `<stateDir>/workspace`. */
  workingDir: string;
  /** True when the working directory came from argv (then it is not auto-created). */
  workingDirExplicit: boolean;
  sandbox: SandboxConfig;
  downloadChannel?: string;
}

export function resolveBoot(args: string[] = process.argv.slice(2)): BootPlan {
  if (args[0] === "ext") {
    return {
      mode: "ext",
      extArgs: args.slice(1),
      stateDir: defaultStateDir(),
      workingDir: join(defaultStateDir(), "workspace"),
      workingDirExplicit: false,
      sandbox: { type: "host" },
    };
  }

  let sandbox: SandboxConfig = { type: "host" };
  let workingDirArg: string | undefined;
  let stateDirArg: string | undefined;
  let downloadChannel: string | undefined;
  let help = false;
  let version = false;
  let onboard = false;
  let workerToken = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let taken;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v" || arg === "-V") {
      version = true;
    } else if (arg === "--onboard") {
      onboard = true;
    } else if (arg === "--worker-token") {
      workerToken = true;
    } else if ((taken = takeValueFlag(args, i, "--sandbox"))) {
      sandbox = parseSandboxArg(taken.value);
      i = taken.lastIndex;
    } else if ((taken = takeValueFlag(args, i, "--state-dir"))) {
      stateDirArg = taken.value;
      i = taken.lastIndex;
    } else if ((taken = takeValueFlag(args, i, "--download"))) {
      downloadChannel = taken.value;
      i = taken.lastIndex;
    } else if (!arg.startsWith("-")) {
      workingDirArg = arg;
    } else {
      throw new Error(`Unknown flag: ${arg}. Run \`mikan --help\` for usage.`);
    }
  }

  const stateDir = stateDirArg ? resolve(stateDirArg) : defaultStateDir();
  return {
    mode: help
      ? "help"
      : version
        ? "version"
        : workerToken
          ? "worker-token"
          : onboard
            ? "onboard"
            : downloadChannel
              ? "download"
              : "run",
    stateDir,
    workingDir: workingDirArg ? resolve(workingDirArg) : join(stateDir, "workspace"),
    workingDirExplicit: workingDirArg !== undefined,
    sandbox,
    downloadChannel,
  };
}

export function helpText(): string {
  return `mikan — multi-platform chat agent daemon

Usage:
  mikan [options] [working-directory]
      Start the daemon. The working directory defaults to <state-dir>/workspace.
  mikan ext <install|validate|list|remove> …
      Manage extensions (run \`mikan ext\` for details).

Options:
  --state-dir <dir>      State directory (settings.json, vaults, extensions).
                         Default: ~/.mikan
  --sandbox <spec>       Execution sandbox. One of:
                           host
                           container:<existing-container-name>
                           image:<image[:tag]>
                           gondolin:default | gondolin:remote
                           firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
                           cloudflare:<sandbox-id>
                         Default: host
  --onboard              Create <state-dir>/settings.json from a template, then exit.
  --worker-token         Mint a one-time gondolin worker join token, then exit.
  --download <channel>   Dump a Slack channel's history (Slack only), then exit.
  --version, -v          Print the version.
  --help, -h             Show this help.

Environment (platform tokens select which chat adapters start):
  Slack:    SLACK_APP_TOKEN + SLACK_BOT_TOKEN
  Telegram: TELEGRAM_BOT_TOKEN
  Discord:  DISCORD_BOT_TOKEN
  GitHub:   GITHUB_APP_ID + GITHUB_INSTALLATION_ID + GITHUB_APP_PRIVATE_KEY(_PATH)`;
}
