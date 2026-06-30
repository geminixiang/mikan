/**
 * Agent session runtime — manages session file creation, opening, and reset.
 *
 * This is a lightweight version of pi-coding-agent's AgentSessionRuntime.
 * Mikan doesn't need session switching (/new, /fork, /import) — it only needs:
 * - Opening a managed session (top-level or thread)
 * - Resetting a session (biweekly rotation or /new command)
 */
import { join } from "path";
import { SessionManager } from "./session-manager.js";
import {
  createManagedSessionFile,
  createManagedSessionFileAtPath,
  getThreadSessionFile,
  openManagedSession,
  extractSessionUuid as extractUuid,
} from "../sessions/store.js";

export type { SessionManager } from "./session-manager.js";

/** Resolved session scope passed from platform adapters. */
export interface ResolvedSessionScope {
  sessionDir: string;
  contextFile: string;
  threadRootMessage: ThreadRootMessage | null;
}

/** Thread root message for thread session naming. */
export interface ThreadRootMessage {
  text?: string;
  userName?: string;
  user?: string;
}

export class AgentSessionRuntime {
  private sessionManagerInstance: SessionManager;
  private sessionUuidValue: string;

  constructor(
    readonly sessionKey: string,
    readonly conversationDir: string,
    readonly cwd: string,
    scope: ResolvedSessionScope,
  ) {
    const { sessionDir, contextFile } = scope;
    this.sessionManagerInstance = openManagedSession(contextFile, sessionDir, cwd);
    this.sessionUuidValue = extractUuid(contextFile);
  }

  get sessionManager(): SessionManager {
    return this.sessionManagerInstance;
  }

  get sessionUuid(): string {
    return this.sessionUuidValue;
  }

  /** Reset session — thread sessions create a fresh fixed-path file, top-level creates a new timestamped file. */
  reset(): void {
    if (this.sessionKey.includes(":")) {
      const threadFile = getThreadSessionFile(this.conversationDir, this.sessionKey);
      createManagedSessionFileAtPath(threadFile, this.cwd);
      this.sessionManagerInstance = openManagedSession(threadFile, "", this.cwd);
    } else {
      const sessionDir = this.getChannelSessionDir();
      const file = createManagedSessionFile(sessionDir, this.cwd);
      this.sessionManagerInstance = openManagedSession(file, sessionDir, this.cwd);
    }
    this.sessionUuidValue = extractUuid(this.sessionManagerInstance.getSessionFile() ?? "");
  }

  private getChannelSessionDir(): string {
    return join(this.conversationDir, "sessions");
  }
}

export { extractUuid as extractSessionUuid };
