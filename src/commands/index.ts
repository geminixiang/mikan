import { AutoReplyCommandHandler } from "./auto-reply.js";
import { LoginCommandHandler } from "./login.js";
import { ModelCommandHandler } from "./model.js";
import { NewCommandHandler } from "./new.js";
import { SandboxCommandHandler } from "./sandbox.js";
import { SessionViewCommandHandler } from "./session-view.js";
import type { CommandHandler } from "./types.js";

export { dispatchCommand } from "./registry.js";
export type { CommandContext, CommandHandler, CommandServices } from "./types.js";

export function defaultCommandHandlers(): CommandHandler[] {
  return [
    new LoginCommandHandler(),
    new SessionViewCommandHandler(),
    new AutoReplyCommandHandler(),
    new ModelCommandHandler(),
    new SandboxCommandHandler(),
    new NewCommandHandler(),
  ];
}
