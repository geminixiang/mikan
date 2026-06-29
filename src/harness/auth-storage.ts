import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { mkdirSync } from "fs";

export interface AuthStatus {
  configured: boolean;
  source?: string;
}

export class AuthStorage {
  private constructor(private readonly path: string) {}

  static create(path: string): AuthStorage {
    return new AuthStorage(path);
  }

  getApiKey(provider: string): string | undefined {
    const env = process.env[getProviderEnvName(provider)];
    if (env) return env;
    return this.read().apiKeys?.[provider];
  }

  setApiKey(provider: string, apiKey: string): void {
    const data = this.read();
    data.apiKeys ??= {};
    data.apiKeys[provider] = apiKey;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2));
  }

  getProviderAuthStatus(provider: string): AuthStatus {
    const envName = getProviderEnvName(provider);
    if (process.env[envName]) return { configured: true, source: envName };
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

function getProviderEnvName(provider: string): string {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "google":
      return "GOOGLE_API_KEY";
    case "mistral":
      return "MISTRAL_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    default:
      return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  }
}
