import { commandForms } from "../../commands/manifest.js";
import { matchCommand } from "../../commands/parse.js";
export type { ParsedSessionViewCommand } from "./types.js";
import type { ParsedSessionViewCommand } from "./types.js";

// `session` is the only bare command (manifest `bare: true`), so its grammar
// includes the slash-less spelling alongside the derived slash forms.
const SESSION_VIEW_COMMANDS = commandForms("session");

export function parseSessionViewCommand(text: string): ParsedSessionViewCommand | null {
  const matched = matchCommand(text, SESSION_VIEW_COMMANDS);
  return matched ? { command: matched.command } : null;
}
