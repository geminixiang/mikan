import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";

export type BrowserCommandType =
  | "list_tabs"
  | "open_tab"
  | "activate_tab"
  | "reload_tab"
  | "get_active_tab"
  | "screenshot"
  | "wait_for"
  | "reload_until"
  | "inspect_page"
  | "find_elements"
  | "find_iframes";

export interface BrowserCommand {
  id: string;
  type: BrowserCommandType;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface BrowserCommandResult {
  ok: boolean;
  error?: string;
  data?: unknown;
}

interface PairingCode {
  code: string;
  platform: string;
  platformUserId: string;
  conversationId: string;
  expiresAt: number;
}

interface BrowserConnection {
  browserId: string;
  tokenHash: string;
  platform: string;
  platformUserId: string;
  conversationId: string;
  name?: string;
  createdAt: number;
  lastSeenAt: number;
  pending: BrowserCommand[];
}

interface WaitingCommand {
  resolve: (result: BrowserCommandResult) => void;
  timeout: NodeJS.Timeout;
}

const PAIRING_TTL_MS = 10 * 60 * 1000;
const COMMAND_WAIT_MS = 75 * 1000;

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  return leftBuf.length === rightBuf.length && timingSafeEqual(leftBuf, rightBuf);
}

function makePairCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = randomBytes(8);
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

export class BrowserExtensionManager {
  private readonly pairings = new Map<string, PairingCode>();
  private readonly browsers = new Map<string, BrowserConnection>();
  private readonly waiting = new Map<string, WaitingCommand>();

  createPairing(platform: string, platformUserId: string, conversationId: string): PairingCode {
    this.purge();
    let code = makePairCode();
    while (this.pairings.has(code)) code = makePairCode();
    const pairing = {
      code,
      platform,
      platformUserId,
      conversationId,
      expiresAt: Date.now() + PAIRING_TTL_MS,
    };
    this.pairings.set(code, pairing);
    return pairing;
  }

  completePairing(
    code: string,
    name?: string,
  ): { browserId: string; token: string; conversationId: string } | undefined {
    this.purge();
    const normalized = code.trim().toUpperCase();
    const pairing = this.pairings.get(normalized);
    if (!pairing || pairing.expiresAt < Date.now()) return undefined;
    this.pairings.delete(normalized);

    const browserId = `br_${randomUUID()}`;
    const token = randomToken();
    this.browsers.set(browserId, {
      browserId,
      tokenHash: tokenHash(token),
      platform: pairing.platform,
      platformUserId: pairing.platformUserId,
      conversationId: pairing.conversationId,
      name,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      pending: [],
    });
    return { browserId, token, conversationId: pairing.conversationId };
  }

  authenticate(browserId: string, token: string): BrowserConnection | undefined {
    const browser = this.browsers.get(browserId);
    if (!browser) return undefined;
    if (!safeEqual(browser.tokenHash, tokenHash(token))) return undefined;
    browser.lastSeenAt = Date.now();
    return browser;
  }

  listForConversation(conversationId: string): Array<{
    browserId: string;
    name?: string;
    lastSeenAt: number;
    pendingCount: number;
  }> {
    return [...this.browsers.values()]
      .filter((browser) => browser.conversationId === conversationId)
      .map((browser) => ({
        browserId: browser.browserId,
        name: browser.name,
        lastSeenAt: browser.lastSeenAt,
        pendingCount: browser.pending.length,
      }));
  }

  latestForConversation(conversationId: string): string | undefined {
    return this.listForConversation(conversationId).sort(
      (left, right) => right.lastSeenAt - left.lastSeenAt,
    )[0]?.browserId;
  }

  takeCommands(browserId: string, token: string): BrowserCommand[] | undefined {
    const browser = this.authenticate(browserId, token);
    if (!browser) return undefined;
    const commands = browser.pending.splice(0, 5);
    return commands;
  }

  async enqueueAndWait(
    conversationId: string,
    type: BrowserCommandType,
    payload?: Record<string, unknown>,
    browserId = this.latestForConversation(conversationId),
  ): Promise<{ browserId: string; command: BrowserCommand; result: BrowserCommandResult }> {
    if (!browserId)
      throw new Error("No paired browser for this conversation. Run `/pi-login browser` first.");
    const browser = this.browsers.get(browserId);
    if (!browser || browser.conversationId !== conversationId) {
      throw new Error("Browser is not paired with this conversation.");
    }

    const command: BrowserCommand = {
      id: `bc_${randomUUID()}`,
      type,
      payload,
      createdAt: Date.now(),
    };
    browser.pending.push(command);

    const result = await new Promise<BrowserCommandResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.waiting.delete(command.id);
        resolve({ ok: false, error: "Timed out waiting for browser extension result" });
      }, COMMAND_WAIT_MS);
      timeout.unref();
      this.waiting.set(command.id, { resolve, timeout });
    });

    return { browserId, command, result };
  }

  completeCommand(
    browserId: string,
    token: string,
    commandId: string,
    result: BrowserCommandResult,
  ): boolean {
    const browser = this.authenticate(browserId, token);
    if (!browser) return false;
    const waiting = this.waiting.get(commandId);
    if (!waiting) return false;
    clearTimeout(waiting.timeout);
    this.waiting.delete(commandId);
    waiting.resolve(result);
    return true;
  }

  purge(): void {
    const now = Date.now();
    for (const [code, pairing] of this.pairings) {
      if (pairing.expiresAt < now) this.pairings.delete(code);
    }
  }
}
