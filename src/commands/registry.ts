import { MikanModels } from "../harness/index.js";
import { AdminCommandHandler } from "./admin.js";
import { AutoReplyCommandHandler } from "./auto-reply.js";
import { ExtensionsCommandHandler } from "./extensions.js";
import { LoginCommandHandler } from "./login.js";
import { ModelCommandHandler } from "./model.js";
import { NewCommandHandler } from "./new.js";
import { SandboxCommandHandler } from "./sandbox.js";
import { SessionViewCommandHandler } from "./session-view.js";
import type { CommandContext, CommandHandler, ModelRegistry } from "./types.js";

export function defaultCommandHandlers(
  modelRegistry: ModelRegistry = MikanModels.create(),
): CommandHandler[] {
  return [
    new AdminCommandHandler(),
    new LoginCommandHandler(),
    new SessionViewCommandHandler(),
    new AutoReplyCommandHandler(),
    new ModelCommandHandler(modelRegistry),
    new SandboxCommandHandler(),
    new ExtensionsCommandHandler(),
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
