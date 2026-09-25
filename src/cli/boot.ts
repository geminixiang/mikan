import { join, resolve } from "node:path";
import { envSummaryLines } from "../env-manifest.js";
import { parseSandboxArg } from "../sandbox/registry.js";
import type { BootPlan } from "./types.js";
import { cliCommand, defaultStateDir, nonEmptyValue, resolveStateDir } from "./arg-grammar.js";

const SUBCOMMANDS = ["office", "sessions", "sandbox", "env"] as const;

interface BootOptions {
  stateDir?: string;
  sandbox?: string;
  download?: string;
  help?: boolean;
  version?: boolean;
  onboard?: boolean;
}

function bootCommand() {
  return cliCommand("mikan")
    .description("Multi-platform chat agent daemon")
    .helpOption(false)
    .argument("[working-directory...]", "Workspace directory (default: <state-dir>/workspace)")
    .option("--state-dir <dir>", "State directory (default: ~/.mikan)", nonEmptyValue)
    .option(
      "--sandbox <spec>",
      "host | container:<name> | image:<image[:tag]> | cloudflare:<id>",
      nonEmptyValue,
    )
    .option("--download <channel>", "Dump a Slack channel's history, then exit", nonEmptyValue)
    .option("--onboard", "Interactive first-run setup (also: mikan onboard)")
    .option("-v, --version", "Print version")
    .option("-V", "Print version")
    .option("-h, --help", "Show help");
}

export function resolveBoot(args: string[] = process.argv.slice(2)): BootPlan {
  const routed = subcommandPlan(args);
  if (routed) return routed;

  const command = bootCommand();
  command.parse(args, { from: "user" });
  const options = command.opts<BootOptions & { V?: boolean }>();
  const onboardFirst = args[0] === "onboard";
  const workingDirArg = (onboardFirst ? command.args.slice(1) : command.args).at(-1);
  const downloadChannel = options.download;
  const sandboxArg = options.sandbox;
  const stateDir = resolveStateDir(args);
  return {
    mode: bootMode({ ...options, version: options.version || options.V }, onboardFirst),
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
    officeArgs: mode === "office" ? args.slice(1) : undefined,
    sessionsArgs: mode === "sessions" ? args.slice(1) : undefined,
    sandboxArgs: mode === "sandbox" ? args.slice(1) : undefined,
    stateDir,
    workingDir: join(stateDir, "workspace"),
    workingDirExplicit: false,
    sandbox: { type: "host" },
  };
}

function bootMode(options: BootOptions, onboardFirst: boolean): BootPlan["mode"] {
  if (options.help) return "help";
  if (options.version) return "version";
  if (onboardFirst || options.onboard) return "onboard";
  if (options.download) return "download";
  return "run";
}

export function helpText(): string {
  return (
    bootCommand().helpInformation() +
    `
Commands:
  mikan office <list|claim|migrate-openconnector|migrate-events|migrate-door-policy>  Inspect offices, claim legacy directories, migrate legacy state.
  mikan sessions migrate     Migrate legacy sessions (stop the daemon first).
  mikan sandbox <status|diff|migrate> --image <image>  Inspect and upgrade image:* sandboxes (stop the daemon before migrate).
  mikan env                  Show environment-variable inventory.
  mikan onboard              Interactive first-run setup.

Environment (platform tokens select which chat adapters start):
${envSummaryLines().join("\n")}
Run mikan env for the full inventory.`
  );
}
