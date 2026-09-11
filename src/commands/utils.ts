import type { ConversationEvent } from "../adapter.js";
import type { CommandContext } from "./types.js";

export async function replyDiagnosticWithContext(
  responder: CommandContext["responder"],
  text: string,
  options?: { style?: "muted" | "error" },
): Promise<void> {
  await responder.setTyping(false);
  await responder.setWorking(false);
  await responder.respondDiagnostic(text, options);
}

export async function replyPrivatelyWithContext(
  context: CommandContext,
  text: string,
  options?: { style?: "muted" | "error" },
): Promise<void> {
  if (context.privateConversation) {
    await replyDiagnosticWithContext(context.responder, text, options);
    return;
  }

  if (context.bot.postPrivateDiagnostic) {
    await context.bot.postPrivateDiagnostic(
      context.conversationId,
      context.platformUserId,
      text,
      options,
    );
    return;
  }

  if (context.bot.postPrivate) {
    await context.bot.postPrivate(context.conversationId, context.platformUserId, text);
    return;
  }

  await replyDiagnosticWithContext(context.responder, text, options);
}

/** Shared reply body for the commands that need the link portal configured. */
export function portalNotConfiguredLines(feature: string): string[] {
  return [
    `${feature} is not configured.`,
    "Set `MIKAN_LINK_URL` or `MIKAN_LINK_PORT` on the server.",
  ];
}

/** Muted `_Title_` summary reply in the conversation the command arrived from. */
export async function replySummary(
  context: CommandContext,
  title: string,
  lines: string[],
): Promise<void> {
  await replyDiagnosticWithContext(context.responder, formatCommandSummary(title, lines), {
    style: "muted",
  });
}

/** Same summary, routed to the user privately when the conversation is shared. */
export async function replySummaryPrivately(
  context: CommandContext,
  title: string,
  lines: string[],
): Promise<void> {
  await replyPrivatelyWithContext(context, formatCommandSummary(title, lines), { style: "muted" });
}

export function formatCommandSummary(title: string, lines: string[]): string {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const compactLines =
    nonEmpty.length <= 2 ? nonEmpty : [nonEmpty[0], nonEmpty.slice(1).join(" · ")];
  return [`_${title}_`, ...compactLines].join("\n");
}

export function isPrivateConversation(event: ConversationEvent): boolean {
  return (
    event.conversationKind === "direct" || event.type === "dm" || event.type === "private_command"
  );
}
