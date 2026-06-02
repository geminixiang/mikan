import {
  ChatSessionManager,
  registerThreadSession,
  waitForThreadSessionBootstrap,
  type ThreadBootstrapWaitOptions,
} from "../../sessions/chat-session-manager.js";
import type { ResolvedSessionScope } from "../../sessions/store.js";

export type SlackResolvedSessionScope = ResolvedSessionScope;

export interface ResolveSlackSessionScopeOptions {
  conversationDir: string;
  sessionKey: string;
  cwd?: string;
  currentMessageId?: string;
}

export interface RegisterSlackThreadSessionOptions {
  conversationDir: string;
  sessionKey: string;
  cwd?: string;
}

export type SlackThreadBootstrapWaitOptions = ThreadBootstrapWaitOptions;

export function registerSlackThreadSession(
  options: RegisterSlackThreadSessionOptions,
): string | null {
  return registerThreadSession(options);
}

export async function waitForSlackThreadBootstrap(
  options: SlackThreadBootstrapWaitOptions,
): Promise<boolean> {
  return waitForThreadSessionBootstrap(options);
}

export async function resolveSlackSessionScope(
  options: ResolveSlackSessionScopeOptions,
): Promise<SlackResolvedSessionScope> {
  return new ChatSessionManager().resolveSessionScope(options);
}
