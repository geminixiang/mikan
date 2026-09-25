import { MikanModels } from "../../harness/models.js";
import { AdminCommandHandler } from "./admin.js";
import { AutoReplyCommandHandler } from "./auto-reply.js";
import { LoginCommandHandler } from "./login.js";
import { COMMAND_MANIFEST } from "./manifest.js";
import { ModelCommandHandler } from "./model.js";
import { NewCommandHandler } from "./new.js";
import { SandboxCommandHandler } from "./sandbox.js";
import { SessionViewCommandHandler } from "./session-view.js";
import type { CommandContext, CommandHandler, ModelRegistry } from "./types.js";

const HANDLER_FACTORIES: Record<string, (modelRegistry: ModelRegistry) => CommandHandler> = {
  admin: () => new AdminCommandHandler(),
  autoreply: () => new AutoReplyCommandHandler(),
  login: () => new LoginCommandHandler(),
  session: () => new SessionViewCommandHandler(),
  model: (modelRegistry) => new ModelCommandHandler(modelRegistry),
  sandbox: () => new SandboxCommandHandler(),
  new: () => new NewCommandHandler(),
};

export function defaultCommandHandlers(
  modelRegistry: ModelRegistry = MikanModels.create(),
): CommandHandler[] {
  return COMMAND_MANIFEST.filter((entry) => !entry.magicWord).map((entry) => {
    const factory = HANDLER_FACTORIES[entry.name];
    if (!factory) {
      throw new Error(
        `Command manifest entry "${entry.name}" has no handler factory in commands/registry.ts`,
      );
    }
    return factory(modelRegistry);
  });
}

export async function dispatchCommand(
  handlers: readonly CommandHandler[],
  context: CommandContext,
): Promise<boolean> {
  for (const handler of handlers) {
    if (await handler.tryHandle(context)) return true;
  }
  return false;
}
