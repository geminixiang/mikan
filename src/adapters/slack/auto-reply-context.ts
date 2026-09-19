import { formatRecentScope, readRecentScope } from "./jev-context.js";

/** The one question Jev answers for an unaddressed shared-channel message. */
export const JEV_ADDRESSED_INSTRUCTIONS =
  "Given the recent Slack conversation, does the NEW message address, ask, or request the mikan AI assistant to do something (including continuing something mikan was already helping with), rather than being conversation between humans that needs no reply from mikan?";

/**
 * Build the shared `state` Jev scores when deciding whether an unaddressed
 * shared-channel message is meant for mikan: the surrounding scope plus, for
 * a thread, whether mikan has already taken part in it.
 */
export function buildAutoReplyState(
  conversationDir: string,
  event: { ts: string; thread_ts?: string; user: string; text: string },
  options: { speaker?: string; limit?: number } = {},
): string {
  const recent = readRecentScope(conversationDir, event, options.limit);
  const header = event.thread_ts
    ? `Slack thread reply. mikan has ${recent.some((l) => l.isMikan) ? "already replied" : "not replied"} in this thread.`
    : "Slack channel top-level message.";
  return [
    header,
    "",
    "Recent messages (oldest first):",
    formatRecentScope(recent),
    "",
    `NEW message from ${options.speaker ?? event.user}:`,
    event.text,
  ].join("\n");
}
