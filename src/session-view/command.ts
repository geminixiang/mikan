import { matchCommand } from "../commands/parse.js";

export interface ParsedSessionViewCommand {
  command: "session" | "/session" | "/pi-session";
}

const SESSION_VIEW_COMMANDS = ["session", "/session", "/pi-session"] as const;

export function parseSessionViewCommand(text: string): ParsedSessionViewCommand | null {
  const matched = matchCommand(text, SESSION_VIEW_COMMANDS);
  return matched ? { command: matched.command } : null;
}
