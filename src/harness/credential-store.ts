import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { atomicWritePrivateFile } from "../utils/fs-atomic.js";

export const MIKAN_AUTH_PATH = join(homedir(), ".pi", "mikan", "auth.json");

type CredentialData = Record<string, Credential>;

/**
 * File-backed CredentialStore for pi-ai's `Models`, reading/writing the same
 * `~/.pi/mikan/auth.json` schema previously owned by pi-coding-agent's AuthStorage.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly authPath: string = MIKAN_AUTH_PATH) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return this.readAll()[providerId];
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      const data = this.readAll();
      const next = await fn(data[providerId]);
      if (next !== undefined) {
        data[providerId] = next;
        this.writeAll(data);
      }
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.enqueue(providerId, async () => {
      const data = this.readAll();
      delete data[providerId];
      this.writeAll(data);
    });
  }

  /** Serialize operations per provider id so concurrent modify()/delete() calls don't race. */
  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    this.chains.set(
      providerId,
      next.catch(() => undefined),
    );
    return next;
  }

  private readAll(): CredentialData {
    if (!existsSync(this.authPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.authPath, "utf-8"));
      return parsed && typeof parsed === "object" ? (parsed as CredentialData) : {};
    } catch {
      return {};
    }
  }

  private writeAll(data: CredentialData): void {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWritePrivateFile(this.authPath, `${JSON.stringify(data, null, 2)}\n`);
  }
}
