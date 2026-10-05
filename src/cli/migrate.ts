import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { InvalidArgumentError } from "commander";
import { platformIsActive, readEnv } from "../env-manifest.js";
import { pendingMigrations, runMigrations } from "../migrations/index.js";
import { parseSandboxArg } from "../sandbox/registry.js";
import { globalSettingsPath } from "../settings/index.js";
import type { DockerCli } from "../migrations/types.js";
import { assertPlatformName } from "../office/index.js";
import type { PlatformName } from "../types.js";
import { errorMessage } from "../unknown-values.js";
import { cliCommand, commandExitCode, nonEmptyValue, stateDirPath } from "./arg-grammar.js";

const PLATFORMS: readonly PlatformName[] = ["slack", "telegram", "discord", "github"];

const execFileAsync = promisify(execFile);

const dockerCli: DockerCli = async (args) => (await execFileAsync("docker", [...args])).stdout;

function collectOwner(value: string, owners: Map<string, PlatformName>): Map<string, PlatformName> {
  const separator = value.lastIndexOf("=");
  if (separator <= 0) throw new InvalidArgumentError("expected <conversationId>=<platform>");
  try {
    owners.set(value.slice(0, separator), assertPlatformName(value.slice(separator + 1)));
  } catch (error) {
    throw new InvalidArgumentError(errorMessage(error));
  }
  return owners;
}

function assertInstallPaths(stateDir: string, workspaceRoot: string): void {
  const settingsPath = globalSettingsPath(stateDir);
  if (!existsSync(settingsPath)) {
    throw new Error(
      `No settings at ${settingsPath}; move the state directory the daemon ran with to ${stateDir}`,
    );
  }
  if (!existsSync(workspaceRoot)) {
    throw new Error(
      `Workspace ${workspaceRoot} does not exist; pass the working directory the daemon ran with as --workspace`,
    );
  }
}

interface MigrateOptions {
  workspace?: string;
  dryRun?: boolean;
  sandbox: string;
  owner: Map<string, PlatformName>;
}

export async function runMigrateCommand(argv: string[], docker = dockerCli): Promise<number> {
  const command = cliCommand("mikan migrate")
    .description("Apply pending state migrations (stop the daemon first)")
    .option("--workspace <dir>", "Workspace directory (default: ~/.mikan/workspace)")
    .requiredOption(
      "--sandbox <spec>",
      "The daemon's --sandbox value: host | container:<name> | image:<image> | cloudflare:<id>",
      nonEmptyValue,
    )
    .option("--dry-run", "List what each pending migration would change, without writing")
    .option(
      "--owner <conversationId=platform>",
      "Owning platform for a legacy conversation directory (repeatable)",
      collectOwner,
      new Map<string, PlatformName>(),
    );
  try {
    command.parse(argv, { from: "user" });
  } catch (error) {
    return commandExitCode(error, command);
  }
  const options = command.opts<MigrateOptions>();
  const stateDir = stateDirPath();
  const dryRun = options.dryRun ?? false;
  const workspaceRoot = options.workspace
    ? resolve(options.workspace)
    : join(stateDir, "workspace");
  try {
    const sandbox = parseSandboxArg(options.sandbox);
    if (pendingMigrations(stateDir).length > 0) assertInstallPaths(stateDir, workspaceRoot);
    const ran = await runMigrations({
      workspaceRoot,
      stateDir,
      dryRun,
      owners: options.owner,
      sandbox,
      enabledPlatforms: PLATFORMS.filter((platform) => platformIsActive(platform)),
      piAgentDir: readEnv("PI_CODING_AGENT_DIR") ?? join(homedir(), ".pi", "agent"),
      modelsPath: join(stateDir, "models.json"),
      docker,
      report: (line) => console.log(line),
    });
    if (ran.length === 0) console.log("No pending migrations.");
    else if (!dryRun) console.log(`Applied ${ran.length}.`);
    else {
      console.log(`Dry run: ${ran.length} pending.`);
      console.log("Each step was previewed against the files as they are now, so a step may find");
      console.log("more to do once the steps before it have run.");
    }
    return 0;
  } catch (error) {
    console.error(`Migration failed: ${errorMessage(error)}`);
    return 1;
  }
}
