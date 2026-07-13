import { COMMAND_MANIFEST } from "./manifest.js";

/**
 * Chat-command text recognition, derived from the command manifest so the
 * inventory has a single source of truth. Session resume uses it to keep
 * command messages out of replayed history.
 *
 * The `pi-[\w-]+` alternative is a catch-all for platform-prefixed command
 * names (including ones a platform registers but this build no longer
 * handles), independent of the manifest.
 */
const COMMAND_NAMES = COMMAND_MANIFEST.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]);

const COMMAND_TEXT_PATTERN = new RegExp(
  `^\\/(?:pi-[\\w-]+|${COMMAND_NAMES.join("|")})(?:@\\w+)?(?:\\s|$)`,
  "i",
);

export function isCommandText(text: string): boolean {
  return COMMAND_TEXT_PATTERN.test(text.trim());
}
