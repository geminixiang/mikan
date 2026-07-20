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
import { envSummaryLines } from "../env-manifest.js";
import { parseSandboxArg, type SandboxConfig } from "../sandbox/index.js";
import { defaultStateDir, resolveStateDir, takeValueFlag } from "./arg-grammar.js";

export interface BootPlan {
  mode:
    | "ext"
    | "env"
    | "help"
    | "version"
    | "worker-token"
    | "migrate-conversation-storage"
    | "onboard"
    | "download"
    | "run";
  /** argv after `ext`, handed to runExtCommand. Only set for mode "ext". */
  extArgs?: string[];
  stateDir: string;
  /** Resolved working directory; defaults to `<stateDir>/workspace`. */
  workingDir: string;
  /** True when the working directory came from argv (then it is not auto-created). */
  workingDirExplicit: boolean;
  sandbox: SandboxConfig;
  downloadChannel?: string;
  workerName?: string;
  conversationStorageManifest?: string;
}

export function resolveBoot(args: string[] = process.argv.slice(2)): BootPlan {
  if (args[0] === "ext" || args[0] === "env") {
    return {
      mode: args[0],
      ...(args[0] === "ext" ? { extArgs: args.slice(1) } : {}),
      stateDir: defaultStateDir(),
      workingDir: join(defaultStateDir(), "workspace"),
      workingDirExplicit: false,
      sandbox: { type: "host" },
    };
  }

  let sandbox: SandboxConfig = { type: "host" };
  let workingDirArg: string | undefined;
  let downloadChannel: string | undefined;
  let help = false;
  let version = false;
  let onboard = false;
  let workerToken = false;
  let conversationStorageManifest: string | undefined;
  let workerName: string | undefined;

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
    } else if ((taken = takeValueFlag(args, i, "--migrate-conversation-storage"))) {
      conversationStorageManifest = taken.value;
      i = taken.lastIndex;
    } else if ((taken = takeValueFlag(args, i, "--worker-name"))) {
      workerName = taken.value;
      i = taken.lastIndex;
    } else if ((taken = takeValueFlag(args, i, "--sandbox"))) {
      sandbox = parseSandboxArg(taken.value);
      i = taken.lastIndex;
    } else if ((taken = takeValueFlag(args, i, "--state-dir"))) {
      // Consumed here so its value never reads as the positional working
      // dir; the value itself is resolved by resolveStateDir below.
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

  const stateDir = resolveStateDir(args);
  return {
    mode: help
      ? "help"
      : version
        ? "version"
        : workerToken
          ? "worker-token"
          : conversationStorageManifest
            ? "migrate-conversation-storage"
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
    workerName,
    conversationStorageManifest,
  };
}

export function helpText(): string {
  return `mikan — multi-platform chat agent daemon

Usage:
  mikan [options] [working-directory]
      Start the daemon. The working directory defaults to <state-dir>/workspace.
  mikan ext <install|validate|list|remove> …
      Manage extensions (run \`mikan ext\` for details).
  mikan env
      Show the full environment-variable inventory and what is currently set.

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
  --worker-name <name>   Scope --worker-token to an existing identity for rotation.
  --migrate-conversation-storage <manifest>
                         Claim explicitly owned legacy conversation directories and exit.
                         Manifest: {"version":1,"complete":true,"owners":{"<id>":"discord"}}
                         gondolin:remote requires every enrolled worker connected and
                         strictly fences old runtime authority before workspace/vault migration.
                         Scoped normal startup supports Slack/Discord/Telegram/GitHub and Admin.
  --download <channel>   Dump a Slack channel's history (Slack only), then exit.
  --version, -v          Print the version.
  --help, -h             Show this help.

Environment (platform tokens select which chat adapters start):
${envSummaryLines().join("\n")}
Run \`mikan env\` for the full inventory.`;
}
