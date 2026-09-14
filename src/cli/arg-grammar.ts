import { Command, CommanderError, InvalidArgumentError } from "commander";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readEnv } from "../env-manifest.js";

/** Keep parsing testable: callers own output and exit codes. */
export function cliCommand(name: string): Command {
  return new Command(name)
    .configureHelp({ showGlobalOptions: true })
    .exitOverride()
    .configureOutput({
      writeOut: (text) => console.log(text.trimEnd()),
      writeErr: () => {},
    });
}

export function nonEmptyValue(value: string): string {
  if (!value.trim() || value.startsWith("-")) {
    throw new InvalidArgumentError("expected a non-empty value, not an option");
  }
  return value;
}

export function commandExitCode(error: unknown, command: Command): number {
  if (!(error instanceof CommanderError)) throw error;
  if (error.exitCode !== 0) console.error(`${error.message}\n${command.helpInformation()}`);
  return error.exitCode;
}

export function defaultStateDir(): string {
  return join(homedir(), ".mikan");
}

/** Early instrumentation probe: tolerate unrelated flags without loading boot. */
export function resolveStateDir(
  args: string[] = process.argv.slice(2),
  envValue: string | undefined = readEnv("STATE_DIR"),
): string {
  const command = cliCommand("mikan")
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .option("--state-dir <dir>", "State directory", nonEmptyValue);
  command.parse(args, { from: "user" });
  const { stateDir } = command.opts<{ stateDir?: string }>();
  return stateDir !== undefined
    ? resolve(stateDir)
    : envValue
      ? resolve(envValue)
      : defaultStateDir();
}

/** Boot has already folded argv into the environment at this point. */
export function effectiveStateDir(): string {
  return resolveStateDir([]);
}
