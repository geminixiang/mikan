import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { findEnvKeys, getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { AuthStatus } from "./types.js";

export type { AuthStatus } from "./types.js";

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export class AuthStorage {
  private constructor(private readonly path: string) {}

  static create(path: string): AuthStorage {
    return new AuthStorage(path);
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
      return JSON.parse(readFileSync(this.path, "utf-8")) as { apiKeys?: Record<string, string> };
    } catch {
      return {};
    }
  }
}

function getFallbackProviderEnvName(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}
