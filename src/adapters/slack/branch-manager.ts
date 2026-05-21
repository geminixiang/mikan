import {
  createManagedSessionFileAtPath,
  createThreadSessionFileFromRootMessage,
  forkThreadSessionFile,
  forkThreadSessionFileFromRootMessage,
  getChannelSessionDir,
  getThreadSessionFile,
  resolveChannelSessionFile,
  resolveManagedSessionFile,
  type ResolvedSessionScope,
  ThreadRootNotFoundError,
  tryResolveThreadSession,
  type ThreadRootMessage,
} from "../../session-store.js";
import { findLogMessageById, type ConversationLogMessage } from "../../context.js";
import { parseSlackSessionKey } from "./session.js";

export interface SlackBranchBootstrapWaitOptions {
  parentSessionKey: string;
  sessionKey: string;
  hasThreadSession: () => boolean;
  isParentRunning: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export type SlackResolvedSessionScope = ResolvedSessionScope;

export interface ResolveSlackSessionScopeOptions {
  conversationDir: string;
  sessionKey: string;
  cwd?: string;
  sleep?: (ms: number) => Promise<void>;
  retryCount?: number;
  retryDelayMs?: number;
}

export interface RegisterSlackForkSessionOptions {
  conversationDir: string;
  sessionKey: string;
  cwd?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildThreadRootSeed(message: ConversationLogMessage): ThreadRootMessage {
  return {
    text: message.text,
    userName: message.userName,
    user: message.user,
    loggedAt: message.date ? new Date(message.date).getTime() : undefined,
  };
}

async function forkThreadSessionFromRootWithRetry(
  sourceSessionFile: string,
  targetSessionFile: string,
  cwd: string,
  rootMessage: ConversationLogMessage,
  sleep: (ms: number) => Promise<void>,
  retryCount: number,
  retryDelayMs: number,
): Promise<string> {
  const seed = buildThreadRootSeed(rootMessage);

  for (let attempt = 0; attempt < retryCount; attempt++) {
    try {
      return forkThreadSessionFileFromRootMessage(sourceSessionFile, targetSessionFile, cwd, seed);
    } catch (error) {
      if (!(error instanceof ThreadRootNotFoundError)) throw error;
      if (attempt === retryCount - 1) break;
      await sleep(retryDelayMs);
    }
  }

  return createThreadSessionFileFromRootMessage(targetSessionFile, cwd, seed, sourceSessionFile);
}

function createThreadSessionFromRootOrEmpty(
  threadFile: string,
  cwd: string,
  threadRootMessage: ThreadRootMessage | null,
  parentSession?: string,
): string {
  if (threadRootMessage) {
    return createThreadSessionFileFromRootMessage(
      threadFile,
      cwd,
      threadRootMessage,
      parentSession,
    );
  }
  return createManagedSessionFileAtPath(threadFile, cwd);
}

export function hasMaterializedSlackBranchSession(
  conversationDir: string,
  sessionKey: string,
): boolean {
  if (parseSlackSessionKey(sessionKey).kind !== "fork") return false;
  return tryResolveThreadSession(getThreadSessionFile(conversationDir, sessionKey)) !== null;
}

export function registerSlackForkSession(options: RegisterSlackForkSessionOptions): string | null {
  const { conversationDir, sessionKey } = options;
  if (parseSlackSessionKey(sessionKey).kind !== "fork") return null;

  const threadFile = getThreadSessionFile(conversationDir, sessionKey);
  return (
    tryResolveThreadSession(threadFile) ??
    createManagedSessionFileAtPath(threadFile, options.cwd ?? conversationDir)
  );
}

export async function waitForSlackBranchBootstrap(
  options: SlackBranchBootstrapWaitOptions,
): Promise<boolean> {
  const {
    parentSessionKey,
    sessionKey,
    hasThreadSession,
    isParentRunning,
    sleep = defaultSleep,
    pollMs = 100,
  } = options;

  if (parseSlackSessionKey(sessionKey).kind !== "fork") return false;
  if (sessionKey === parentSessionKey) return false;
  if (hasThreadSession()) return false;

  let waited = false;
  while (isParentRunning() && !hasThreadSession()) {
    waited = true;
    await sleep(pollMs);
  }

  return waited;
}

export async function resolveSlackSessionScope(
  options: ResolveSlackSessionScopeOptions,
): Promise<SlackResolvedSessionScope> {
  const {
    conversationDir,
    sessionKey,
    sleep = defaultSleep,
    retryCount = 5,
    retryDelayMs = 100,
  } = options;
  const cwd = options.cwd ?? conversationDir;

  const sessionDir = getChannelSessionDir(conversationDir);
  const sessionRef = parseSlackSessionKey(sessionKey);
  if (sessionRef.kind === "channel") {
    return {
      sessionDir,
      contextFile: resolveManagedSessionFile(sessionDir, cwd),
      threadRootMessage: null,
    };
  }

  const rootTs = sessionRef.anchorTs;
  const threadRootLogMessage = await findLogMessageById(conversationDir, rootTs);
  const threadRootMessage = threadRootLogMessage ? buildThreadRootSeed(threadRootLogMessage) : null;
  const threadFile = getThreadSessionFile(conversationDir, sessionKey);
  const existing = tryResolveThreadSession(threadFile);
  if (existing) {
    return { sessionDir, contextFile: existing, threadRootMessage };
  }

  const conversationSource = resolveChannelSessionFile(conversationDir);
  if (!conversationSource) {
    return {
      sessionDir,
      contextFile: createThreadSessionFromRootOrEmpty(threadFile, cwd, threadRootMessage),
      threadRootMessage,
    };
  }

  try {
    const contextFile = threadRootMessage
      ? await forkThreadSessionFromRootWithRetry(
          conversationSource,
          threadFile,
          cwd,
          threadRootLogMessage!,
          sleep,
          retryCount,
          retryDelayMs,
        )
      : forkThreadSessionFile(conversationSource, threadFile, cwd);
    return { sessionDir, contextFile, threadRootMessage };
  } catch {
    return {
      sessionDir,
      contextFile: createThreadSessionFromRootOrEmpty(
        threadFile,
        cwd,
        threadRootMessage,
        conversationSource,
      ),
      threadRootMessage,
    };
  }
}
