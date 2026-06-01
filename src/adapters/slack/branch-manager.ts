import {
  ChatSessionManager,
  hasMaterializedChatSession,
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

export interface RegisterSlackForkSessionOptions {
  conversationDir: string;
  sessionKey: string;
  cwd?: string;
}

export type SlackBranchBootstrapWaitOptions = ThreadBootstrapWaitOptions;

export function hasMaterializedSlackBranchSession(
  conversationDir: string,
  sessionKey: string,
): boolean {
  return hasMaterializedChatSession({ conversationDir, sessionKey });
}

export function registerSlackForkSession(options: RegisterSlackForkSessionOptions): string | null {
  return registerThreadSession(options);
}

export async function waitForSlackBranchBootstrap(
  options: SlackBranchBootstrapWaitOptions,
): Promise<boolean> {
  return waitForThreadSessionBootstrap(options);
}

export async function resolveSlackSessionScope(
  options: ResolveSlackSessionScopeOptions,
): Promise<SlackResolvedSessionScope> {
  return new ChatSessionManager().resolveSessionScope(options);
}
