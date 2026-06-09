import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import { AdminCommandHandler } from "./admin.js";
import { AutoReplyCommandHandler } from "./auto-reply.js";
import { LoginCommandHandler } from "./login.js";
import { ModelCommandHandler } from "./model.js";
import { NewCommandHandler } from "./new.js";
import { SandboxCommandHandler } from "./sandbox.js";
import { SessionViewCommandHandler } from "./session-view.js";
import type { CommandContext, CommandHandler } from "./types.js";

export function defaultCommandHandlers(): CommandHandler[] {
  const authStorage = AuthStorage.create(join(homedir(), ".pi", "mikan", "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage);
  return [
    new AdminCommandHandler(),
    new LoginCommandHandler(),
    new SessionViewCommandHandler(),
    new AutoReplyCommandHandler(),
    new ModelCommandHandler(modelRegistry),
    new SandboxCommandHandler(),
    new NewCommandHandler(),
  ];
}

/** Run handlers in order, returning true as soon as one accepts the command. */
export async function dispatchCommand(
  handlers: readonly CommandHandler[],
  context: CommandContext,
): Promise<boolean> {
  for (const handler of handlers) {
    if (await handler.tryHandle(context)) return true;
  }
  return false;
}
