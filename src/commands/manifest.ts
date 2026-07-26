/**
 * Platform-agnostic command manifest — the single inventory that platform
 * adapters derive their native slash-command registration and routing from,
 * and that `isCommandText` and the handler grammars mirror.
 *
 * Adding a command means adding a manifest entry plus a handler in this
 * directory; adapters pick up registration and routing from the entry instead
 * of hand-restating the inventory (where a missed spot used to mean a silent
 * no-response).
 *
 * Per CONTEXT.md, slash commands are a minimal chat control surface: detailed
 * or infrequent settings belong in Admin, and bare commands are limited to
 * `session`. `stop` is listed for platform registration/UI only — it is a
 * magic word owned by conversation intake, not a command handler.
 */

import type { CommandManifestEntry, SlackSlashRoute } from "./types.js";

export type { CommandManifestEntry, SlackSlashRoute } from "./types.js";

/** Entry order is the Telegram command-menu order. */
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
    description: "Show or temporarily boost this conversation's sandbox limits",
    arg: {
      name: "action",
      description: "Use 'boost' to temporarily apply the configured boost limits",
      required: false,
    },
    slackCommand: "/pi-sandbox",
    slackRoute: { includeText: true },
    discord: true,
    telegramMenu: { description: "Show or boost sandbox limits" },
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
    discord: true,
    telegramMenu: {},
  },
  {
    name: "admin",
    description: "Open the admin portal",
    slackCommand: "/pi-admin",
    slackRoute: { thread: true },
  },
  {
    name: "extensions",
    description: "List extensions installed for this conversation",
    slackCommand: "/pi-extensions",
    slackRoute: { includeText: true },
  },
  {
    name: "auto-reply",
    description: "Enable, disable, or show auto-reply for this channel",
    aliases: ["autoreply"],
    slackCommand: "/pi-auto-reply",
    slackRoute: { includeText: true },
  },
];

export function commandManifestEntry(name: string): CommandManifestEntry {
  const entry = COMMAND_MANIFEST.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Unknown command in manifest: ${name}`);
  return entry;
}

/** Slash spellings of a command: `/<name>` and `/pi-<name>` for the name and each alias. */
export function slashForms(name: string): readonly string[] {
  const entry = commandManifestEntry(name);
  return [entry.name, ...(entry.aliases ?? [])].flatMap((spelling) => [
    `/${spelling}`,
    `/pi-${spelling}`,
  ]);
}

/** Every accepted spelling: the bare name (when the command is bare) plus slash forms. */
export function commandForms(name: string): readonly string[] {
  const entry = commandManifestEntry(name);
  return [...(entry.bare ? [entry.name] : []), ...slashForms(name)];
}

/** Telegram `setMyCommands` payload (menu registration; routing is separate). */
export function telegramCommandMenu(): { command: string; description: string }[] {
  return COMMAND_MANIFEST.filter((entry) => entry.telegramMenu).map((entry) => ({
    command: entry.name,
    description: entry.telegramMenu?.description ?? entry.description,
  }));
}
