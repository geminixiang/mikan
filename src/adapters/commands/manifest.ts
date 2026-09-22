import type { CommandManifestEntry } from "./types.js";

export type { CommandManifestEntry, SlackSlashRoute } from "./types.js";

export const COMMAND_MANIFEST: readonly CommandManifestEntry[] = [
  {
    name: "login",
    description: "Store credentials in your private vault",
    slackCommand: "/pi-login",
    slackRoute: { includeText: true, privateCommand: true },
    discord: true,
    telegramMenu: {},
  },
  {
    name: "session",
    description: "Open the current session in the web viewer",
    bare: true,
    slackCommand: "/pi-session",
    slackRoute: { thread: true },
    discord: true,
    telegramMenu: {},
  },
  {
    name: "model",
    description: "Switch this conversation's LLM model",
    arg: {
      name: "model",
      description: "provider/model[:thinking], e.g. anthropic/claude-sonnet-4-6:off",
      required: false,
    },
    slackCommand: "/pi-model",
    slackRoute: { includeText: true },
    discord: true,
    telegramMenu: {},
  },
  {
    name: "sandbox",
    description: "Show sandbox status or boost limits",
    arg: {
      name: "action",
      description: "'boost' temporarily applies the configured boost limits",
      required: false,
    },
    slackCommand: "/pi-sandbox",
    slackRoute: { includeText: true },
    discord: true,
    telegramMenu: { description: "Show or boost sandbox limits" },
    telegramCommand: true,
  },
  {
    name: "autoreply",
    aliases: ["auto-reply"],
    description: "Enable, disable, or Jev-assist replies without mentions",
    arg: {
      name: "state",
      description: "on, off, or jev",
      required: true,
    },
    slackCommand: "/pi-auto-reply",
    slackRoute: { includeText: true },
  },
  {
    name: "stop",
    description: "Stop the current conversation",
    magicWord: true,
    discord: true,
    telegramMenu: { description: "Stop ongoing conversation" },
  },
  {
    name: "new",
    description: "Reset conversation history and start fresh",
    slackCommand: "/pi-new",
    slackRoute: {},
    discord: true,
    telegramMenu: {},
    telegramCommand: true,
  },
  {
    name: "admin",
    description: "Open the admin portal",
    slackCommand: "/pi-admin",
    slackRoute: { thread: true },
    discord: true,
    telegramMenu: {},
    telegramCommand: true,
  },
];

export function commandManifestEntry(name: string): CommandManifestEntry {
  const entry = COMMAND_MANIFEST.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Unknown command in manifest: ${name}`);
  return entry;
}

export function slashForms(name: string): readonly string[] {
  const entry = commandManifestEntry(name);
  return [entry.name, ...(entry.aliases ?? [])].flatMap((spelling) => [
    `/${spelling}`,
    `/pi-${spelling}`,
  ]);
}

export function commandForms(name: string): readonly string[] {
  const entry = commandManifestEntry(name);
  return [...(entry.bare ? [entry.name] : []), ...slashForms(name)];
}

export function telegramCommandMenu(): { command: string; description: string }[] {
  return COMMAND_MANIFEST.filter((entry) => entry.telegramMenu).map((entry) => ({
    command: entry.name,
    description: entry.telegramMenu?.description ?? entry.description,
  }));
}

export function matchCommand<Command extends string>(
  text: string,
  aliases: readonly Command[],
  options?: { stripMention?: boolean },
): { command: Command; args: string[] } | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (first === undefined) return null;

  const token = options?.stripMention ? first.replace(/@\w+$/i, "") : first;
  const command = token.toLowerCase() as Command;
  return aliases.includes(command) ? { command, args: tokens.slice(1) } : null;
}

const COMMAND_NAMES = COMMAND_MANIFEST.flatMap((entry) => [entry.name].concat(entry.aliases ?? []));

const COMMAND_TEXT_PATTERN = new RegExp(
  `^\\/(?:pi-[\\w-]+|${COMMAND_NAMES.join("|")})(?:@\\w+)?(?:\\s|$)`,
  "i",
);

export function isCommandText(text: string): boolean {
  return COMMAND_TEXT_PATTERN.test(text.trim());
}
