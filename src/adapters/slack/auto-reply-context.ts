import {
  formatRecentScope,
  humanizeMentions,
  readRecentScope,
  type SlackNameResolver,
} from "./jev-context.js";

/** The one question Jev answers for an unaddressed shared-channel message. */
export const JEV_ADDRESSED_INSTRUCTIONS =
  "Given the recent Slack conversation, does the NEW message address, ask, or request the mikan AI assistant to do something (including continuing something mikan was already helping with), rather than being conversation between humans that needs no reply from mikan? A message that @-mentions a specific person other than mikan is directed at that person.";

/**
 * Build the shared `state` Jev scores when deciding whether an unaddressed
 * shared-channel message is meant for mikan: the surrounding scope plus, for
 * a thread, whether mikan has already taken part in it. Mentions are shown
 * as names so "@someone else" reads as such.
 */
export function buildAutoReplyState(
  conversationDir: string,
  event: { ts: string; thread_ts?: string; user: string; text: string },
  options: {
    speaker?: string;
    limit?: number;
    resolveName?: SlackNameResolver;
    botUserId?: string | null;
  } = {},
): string {
  const resolve = options.resolveName ?? (() => undefined);
  const humanize = (text: string) => humanizeMentions(text, resolve, options.botUserId ?? null);
  const recent = readRecentScope(conversationDir, event, { limit: options.limit, humanize });
  const header = event.thread_ts
    ? `Slack thread reply. mikan has ${recent.some((l) => l.isMikan) ? "already replied" : "not replied"} in this thread.`
    : "Slack channel top-level message.";
  return [
    header,
    "The AI assistant is named mikan; mentions of other people appear as @Name.",
    "",
    "Recent messages (oldest first):",
    formatRecentScope(recent),
    "",
    `NEW message from ${options.speaker ?? event.user}:`,
    humanize(event.text),
  ].join("\n");
}
