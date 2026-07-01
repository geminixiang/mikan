import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { findEnvKeys, getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { getLegacyAuthPath } from "./config.js";
import type { AuthStatus } from "./types.js";

export type { AuthStatus } from "./types.js";

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

/** One-time, best-effort copy from the pre-harness auth.json location. */
function migrateLegacyAuthFile(path: string): void {
  if (existsSync(path)) return;
  const legacyPath = getLegacyAuthPath();
  if (!existsSync(legacyPath)) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    copyFileSync(legacyPath, path);
    chmodSync(path, 0o600);
  } catch {
    // Best-effort: if this fails, the user is no worse off than before this
    // migration existed — they re-run `/login` as they always could.
  }
}

export class AuthStorage {
  private lastError: string | undefined;

  private constructor(private readonly path: string) {
    this.read(); // populate getError() eagerly, mirroring ModelRegistry's refresh-on-create
  }

  static create(path: string): AuthStorage {
    migrateLegacyAuthFile(path);
    return new AuthStorage(path);
  }

  /** Reason the last `read()` failed to parse `auth.json`, if any. */
  getError(): string | undefined {
    return this.lastError;
  }

  getApiKey(provider: string): string | undefined {
    const env = getEnvApiKey(provider) ?? process.env[getFallbackProviderEnvName(provider)];
    if (env) return env;
    return this.read().apiKeys?.[provider];
  }

  setApiKey(provider: string, apiKey: string): void {
    const data = this.read();
    data.apiKeys ??= {};
    data.apiKeys[provider] = apiKey;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(data, null, 2), AUTH_FILE_WRITE_OPTIONS);
    chmodSync(this.path, 0o600);
  }

  getProviderAuthStatus(provider: string): AuthStatus {
    const envName = findEnvKeys(provider)?.[0];
    if (envName) return { configured: true, source: envName };
    const fallbackEnvName = getFallbackProviderEnvName(provider);
    if (process.env[fallbackEnvName]) return { configured: true, source: fallbackEnvName };
    if (getEnvApiKey(provider)) return { configured: true, source: "environment" };
    if (this.read().apiKeys?.[provider]) return { configured: true, source: this.path };
    return { configured: false };
  }

  private read(): { apiKeys?: Record<string, string> } {
    if (!existsSync(this.path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as {
        apiKeys?: Record<string, string>;
      };
      this.lastError = undefined;
      return parsed;
    } catch (err) {
      this.lastError = `Failed to parse ${this.path}: ${err instanceof Error ? err.message : String(err)}`;
      return {};
    }
  }
}

function getFallbackProviderEnvName(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}
