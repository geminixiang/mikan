import { matchCommand } from "../../commands/parse.js";
export type { ParsedSessionViewCommand } from "./types.js";
import type { ParsedSessionViewCommand } from "./types.js";

const SESSION_VIEW_COMMANDS = ["session", "/session", "/pi-session"] as const;

export function parseSessionViewCommand(text: string): ParsedSessionViewCommand | null {
  const matched = matchCommand(text, SESSION_VIEW_COMMANDS);
  return matched ? { command: matched.command } : null;
}
