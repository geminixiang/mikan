import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AuthStorage } from "./auth-storage.js";

export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string };

interface ModelsConfig {
  providers?: Record<string, ProviderConfig>;
}

interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  headers?: Record<string, string>;
  compat?: Model<Api>["compat"];
  models?: Array<{
    id: string;
    name?: string;
    api?: Api;
    baseUrl?: string;
    reasoning?: boolean;
    input?: Array<"text" | "image">;
    cost?: Model<Api>["cost"];
    contextWindow?: number;
    maxTokens?: number;
    headers?: Record<string, string>;
    compat?: Model<Api>["compat"];
  }>;
}

export class ModelRegistry {
  private models: Model<Api>[] = [];
  private customApiKeys = new Map<string, string>();
  private customHeaders = new Map<string, Record<string, string>>();
  private loadError: string | undefined;

  private constructor(
    readonly authStorage: AuthStorage,
    private readonly modelsJsonPath: string,
  ) {
    this.refresh();
  }

  static create(authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry {
    return new ModelRegistry(authStorage, modelsJsonPath ?? join(homedir(), ".pi", "agent", "models.json"));
  }

  refresh(): void {
    this.loadError = undefined;
    this.customApiKeys.clear();
    this.customHeaders.clear();
    this.models = getProviders().flatMap((provider) =>
      getModels(provider as never),
    ) as Model<Api>[];
    if (!existsSync(this.modelsJsonPath)) return;

    try {
      const config = JSON.parse(readFileSync(this.modelsJsonPath, "utf-8")) as ModelsConfig;
      for (const [provider, providerConfig] of Object.entries(config.providers ?? {})) {
        this.addProviderModels(provider, providerConfig);
      }
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  getError(): string | undefined {
    return this.loadError;
  }

  getAll(): Model<Api>[] {
    return this.models;
  }

  getAvailable(): Model<Api>[] {
    return this.models.filter((model) => this.hasConfiguredAuth(model));
  }

  find(provider: string, modelId: string): Model<Api> | undefined {
    return this.models.find((model) => model.provider === provider && model.id === modelId);
  }

  hasConfiguredAuth(model: Model<Api>): boolean {
    return Boolean(
      this.customApiKeys.get(model.provider) || this.authStorage.getApiKey(model.provider),
    );
  }

  async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
    const apiKey = await this.getApiKeyForProvider(model.provider);
    if (!apiKey) return { ok: false, error: `No API key for provider "${model.provider}"` };
    return {
      ok: true,
      apiKey,
      headers: { ...this.customHeaders.get(model.provider), ...model.headers },
    };
  }

  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    return this.customApiKeys.get(provider) ?? this.authStorage.getApiKey(provider);
  }

  getProviderDisplayName(provider: string): string {
    return provider;
  }

  isUsingOAuth(): boolean {
    return false;
  }

  private addProviderModels(provider: string, config: ProviderConfig): void {
    if (config.apiKey) this.customApiKeys.set(provider, config.apiKey);
    if (config.headers) this.customHeaders.set(provider, config.headers);
    for (const model of config.models ?? []) {
      this.upsertModel({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        api: model.api ?? config.api ?? "openai-completions",
        baseUrl: model.baseUrl ?? config.baseUrl ?? "",
        reasoning: model.reasoning ?? false,
        input: model.input ?? ["text"],
        cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow ?? 200000,
        maxTokens: model.maxTokens ?? 8192,
        headers: { ...config.headers, ...model.headers },
        compat: model.compat ?? config.compat,
      } as Model<Api>);
    }
  }

  private upsertModel(model: Model<Api>): void {
    this.models = this.models.filter(
      (existing) => existing.provider !== model.provider || existing.id !== model.id,
    );
    this.models.push(model);
  }
}
