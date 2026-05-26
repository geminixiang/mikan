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

export function isPrivateConversation(event: BotEvent): boolean {
  return (
    event.conversationKind === "direct" || event.type === "dm" || event.type === "private_command"
  );
}
