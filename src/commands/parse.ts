function commandTokens(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function normalizeCommandToken(token: string, options?: { stripMention?: boolean }): string {
  const command = options?.stripMention ? token.replace(/@\w+$/i, "") : token;
  return command.toLowerCase();
}

export function matchCommand<Command extends string>(
  text: string,
  aliases: readonly Command[],
  options?: { stripMention?: boolean },
): { command: Command; args: string[] } | null {
  const tokens = commandTokens(text);
  if (tokens.length === 0) return null;

  const command = normalizeCommandToken(tokens[0], options);
  return aliases.includes(command as Command)
    ? { command: command as Command, args: tokens.slice(1) }
    : null;
}
