import { Command, CommanderError, InvalidArgumentError } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function stateDirPath(): string {
  return join(homedir(), ".mikan");
}
