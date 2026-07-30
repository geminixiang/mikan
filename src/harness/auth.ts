/**
 * File-backed credential store for the mikan harness.
 *
 * Implements pi-ai's `CredentialStore` over mikan's `auth.json`
 * (`~/.mikan/auth.json` by default). The file maps provider ids to
 * type-tagged credentials — the same shape pi-ai documents for auth.json.
 *
 * Writes are atomic (temp file + rename, mode 0600) and serialized per
 * provider within the process. mikan runs as a single process, so no
 * cross-process file lock is taken.
 */
import { existsSync, readFileSync } from "fs";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { atomicWritePrivateFile } from "../utils/file-guards.js";
import * as log from "../log.js";

/** Default location of mikan's credential file. */
export function defaultAuthPath(): string {
  return join(homedir(), ".mikan", "auth.json");
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return type === "api_key" || type === "oauth";
}

export class FileCredentialStore implements CredentialStore {
  private readonly authPath: string;
  private chain = Promise.resolve();

  constructor(authPath: string = defaultAuthPath()) {
    this.authPath = authPath;
  }

  private load(): Record<string, Credential> {
    if (!existsSync(this.authPath)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.authPath, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const data: Record<string, Credential> = {};
      for (const [provider, credential] of Object.entries(parsed)) {
        if (isCredential(credential)) data[provider] = credential;
      }
      return data;
    } catch (err) {
      log.logWarning(
        `Failed to read credentials from ${this.authPath}`,
        err instanceof Error ? err.message : String(err),
      );
      return {};
    }
  }

  private save(data: Record<string, Credential>): void {
    mkdirSync(dirname(this.authPath), { recursive: true });
    atomicWritePrivateFile(this.authPath, `${JSON.stringify(data, null, 2)}\n`);
  }

  /** Serialize read-modify-write cycles so concurrent refreshes cannot clobber each other. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  read(providerId: string): Promise<Credential | undefined> {
    return this.enqueue(async () => this.load()[providerId]);
  }

  list(): Promise<readonly CredentialInfo[]> {
    return this.enqueue(async () =>
      Object.entries(this.load()).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const data = this.load();
      const next = await fn(data[providerId]);
      if (next === undefined) return data[providerId];
      data[providerId] = next;
      this.save(data);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      const data = this.load();
      if (!(providerId in data)) return;
      delete data[providerId];
      this.save(data);
    });
  }
}
