import { randomUUID } from "node:crypto";
export type { WebSession, WebSessionBinding } from "./types.js";
import type { WebSession, WebSessionBinding } from "./types.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class InMemoryWebSessionStore {
  private readonly sessions = new Map<string, WebSession>();

  create(
    oauthIdentity: string,
    bindings: WebSessionBinding[],
  ): { sessionId: string; session: WebSession } {
    const sessionId = randomUUID();
    const session: WebSession = {
      token: sessionId,
      expiresAt: Date.now() + SESSION_TTL_MS,
      oauthIdentity,
      bindings,
    };
    this.sessions.set(sessionId, session);
    return { sessionId, session };
  }

  /** Look up a session by its cookie value. Returns undefined if expired. */
  getSession(sessionId: string): WebSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  /** Look up a session from the browser's Cookie header. */
  getSessionFromCookie(cookieHeader: string | undefined): WebSession | undefined {
    const sessionId = cookieValue(cookieHeader, "mikan_session");
    return sessionId ? this.getSession(sessionId) : undefined;
  }

  /** Remove a session (logout). */
  revoke(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  revokeFromCookie(cookieHeader: string | undefined): void {
    const sessionId = cookieValue(cookieHeader, "mikan_session");
    if (sessionId) this.revoke(sessionId);
  }

  /** Remove expired sessions. */
  purge(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) this.sessions.delete(id);
    }
  }
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trim() !== name) continue;
    return pair.slice(separator + 1).trim();
  }
  return undefined;
}
