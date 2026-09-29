import { officeKey, OfficeRegistry } from "../office/index.js";
import { cliCommand, commandExitCode, nonEmptyValue, resolveStateDir } from "./arg-grammar.js";

export function runOfficeCommand(argv: string[]): number {
  const command = cliCommand("mikan office")
    .description("Inspect conversation offices")
    .option("--state-dir <dir>", "State directory", nonEmptyValue);
  let result = 1;
  command
    .command("list")
    .description("List each registered office key with its platform and conversation id")
    .action(() => {
      result = listOffices(resolveStateDir(argv));
    });
  try {
    command.parse(argv, { from: "user" });
    return result;
  } catch (error) {
    return commandExitCode(error, command);
  }
}

function listOffices(stateDir: string): number {
  const offices = new OfficeRegistry(stateDir).getOffices();
  console.log(`Offices (${offices.length}):`);
  for (const office of offices) {
    console.log(`  ${officeKey(office)}  ${office.platform}  ${office.conversationId}`);
  }
  return 0;
}
