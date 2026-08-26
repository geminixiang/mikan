import { MikanModels } from "../harness/index.js";
import { AdminCommandHandler } from "./admin.js";
import { AutoReplyCommandHandler } from "./auto-reply.js";
import { ExtensionsCommandHandler } from "./extensions.js";
import { LoginCommandHandler } from "./login.js";
import { COMMAND_MANIFEST } from "./manifest.js";
import { ModelCommandHandler } from "./model.js";
import { NewCommandHandler } from "./new.js";
import { SandboxCommandHandler } from "./sandbox.js";
import { SessionViewCommandHandler } from "./session-view.js";
import type { CommandContext, CommandHandler, ModelRegistry } from "./types.js";

/**
 * Handler factory per manifest command name. The manifest is the inventory
 * authority; this map only binds each entry to its implementation, and
 * `defaultCommandHandlers` verifies the binding is complete so a manifest
 * entry without a handler fails at construction instead of dispatching into
 * silence. Magic-word entries (routed by conversation intake) are exempt.
 */
const HANDLER_FACTORIES: Record<string, (modelRegistry: ModelRegistry) => CommandHandler> = {
  admin: () => new AdminCommandHandler(),
  login: () => new LoginCommandHandler(),
  session: () => new SessionViewCommandHandler(),
  "auto-reply": () => new AutoReplyCommandHandler(),
  model: (modelRegistry) => new ModelCommandHandler(modelRegistry),
  sandbox: () => new SandboxCommandHandler(),
  extensions: () => new ExtensionsCommandHandler(),
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
