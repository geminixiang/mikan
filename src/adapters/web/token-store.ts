import { randomBytes } from "node:crypto";
import * as log from "../../log.js";
import type { TokenRecord } from "./types.js";

export class InMemoryTokenStore<T extends TokenRecord> {
  protected readonly tokens = new Map<string, T>();
  protected readonly portal: string | undefined = undefined;
  private readonly opened = new Set<string>();

  protected createRecord(ttlMs: number, data: Omit<T, keyof TokenRecord>): T {
    const token = randomBytes(16).toString("hex");
    const record = { ...data, token, expiresAt: Date.now() + ttlMs } as T;
    this.tokens.set(token, record);
    if (this.portal) log.logInfo(`Portal link created: ${this.portal}`);
    return record;
  }

  protected deleteWhere(predicate: (record: T) => boolean): void {
    for (const [key, record] of this.tokens) {
      if (predicate(record)) this.tokens.delete(key);
    }
  }

  peek(rawToken: string): T | undefined {
    const entry = this.tokens.get(rawToken);
    if (!entry || Date.now() > entry.expiresAt) return undefined;
    this.recordOpened(rawToken);
    return entry;
  }

  consume(rawToken: string): T | undefined {
    const entry = this.tokens.get(rawToken);
    if (!entry) return undefined;
    this.tokens.delete(rawToken);
    if (Date.now() > entry.expiresAt) return undefined;
    this.recordOpened(rawToken);
    this.opened.delete(rawToken);
    return entry;
  }

  purge(): void {
    const now = Date.now();
    for (const [key, t] of this.tokens) {
      if (now > t.expiresAt) {
        this.tokens.delete(key);
        this.opened.delete(key);
      }
    }
  }

  private recordOpened(rawToken: string): void {
    if (!this.portal || this.opened.has(rawToken)) return;
    this.opened.add(rawToken);
    log.logInfo(`Portal link opened: ${this.portal}`);
  }
}
