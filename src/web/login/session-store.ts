import { randomUUID } from "node:crypto";
import type { TokenRecord } from "../types.js";

/** A web session (24h TTL, httpOnly cookie). */
export interface WebSession extends TokenRecord {
  oauthIdentity: string;
  /** Bound platform identities, populated from the binding store on creation. */
  platforms: Array<{ platform: string; platformUserId: string }>;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class InMemoryWebSessionStore {
  private readonly sessions = new Map<string, WebSession>();

  create(
    oauthIdentity: string,
    platforms: WebSession["platforms"],
  ): { sessionId: string; session: WebSession } {
    const sessionId = randomUUID();
    const session: WebSession = {
      token: sessionId,
      expiresAt: Date.now() + SESSION_TTL_MS,
      oauthIdentity,
      platforms,
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

  /** Remove a session (logout). */
  revoke(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Remove expired sessions. */
  purge(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) this.sessions.delete(id);
    }
  }
}
