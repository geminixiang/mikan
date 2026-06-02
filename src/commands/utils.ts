import type { BotEvent } from "../adapter.js";
import type { CommandContext } from "./types.js";

export async function replyWithContext(
  responseCtx: CommandContext["responseCtx"],
  text: string,
): Promise<void> {
  await responseCtx.setTyping(false);
  await responseCtx.setWorking(false);
  await responseCtx.respond(text);
}

export async function replyDiagnosticWithContext(
  responseCtx: CommandContext["responseCtx"],
  text: string,
  options?: { style?: "muted" | "error" },
): Promise<void> {
  await responseCtx.setTyping(false);
  await responseCtx.setWorking(false);
  await responseCtx.respondDiagnostic(text, options);
}

export async function replyPrivatelyWithContext(
  context: CommandContext,
  text: string,
  options?: { style?: "muted" | "error" },
): Promise<void> {
  if (context.privateConversation) {
    await replyDiagnosticWithContext(context.responseCtx, text, options);
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

  await replyDiagnosticWithContext(context.responseCtx, text, options);
}

export function formatCommandSummary(title: string, lines: string[]): string {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const compactLines =
    nonEmpty.length <= 2 ? nonEmpty : [nonEmpty[0], nonEmpty.slice(1).join(" · ")];
  return [`_${title}_`, ...compactLines].join("\n");
}

export function isPrivateConversation(event: BotEvent): boolean {
  return (
    event.conversationKind === "direct" || event.type === "dm" || event.type === "private_command"
  );
}
