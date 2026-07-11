/**
 * Model catalog for the mikan harness.
 *
 * Wraps pi-ai's `Models` collection: all built-in providers are registered
 * with credentials resolved through mikan's auth.json, and custom providers
 * or overrides can be added via a `models.json` file
 * (`~/.mikan/models.json` by default).
 *
 * models.json subset supported by mikan:
 *
 * ```jsonc
 * {
 *   "providers": {
 *     "my-provider": {
 *       "api": "openai-completions",     // required when models are listed
 *       "baseUrl": "http://host/v1",
 *       "apiKey": "literal-key",          // optional; auth.json / MY_PROVIDER_API_KEY otherwise
 *       "headers": { },
 *       "compat": { },
 *       "models": [{ "id": "m", "name": "M", "input": ["text"], "reasoning": false }]
 *     },
 *     "anthropic": { "baseUrl": "https://proxy.example/v1" }  // override built-in provider
 *   }
 * }
 * ```
 */
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  createProvider,
  type Api,
  type AuthResult,
  type Model,
  type Models,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { defaultAuthPath, FileCredentialStore } from "./auth.js";

const CUSTOM_API_STREAMS: Record<string, () => ProviderStreams> = {
  "anthropic-messages": anthropicMessagesApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "mistral-conversations": mistralConversationsApi,
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
};

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;

interface CustomModelConfig {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  /** Accepted alias for `maxTokens` (used by existing deployments). */
  maxOutputTokens?: number;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  headers?: Record<string, string>;
  compat?: unknown;
}

interface CustomProviderConfig {
  name?: string;
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: unknown;
  models?: CustomModelConfig[];
}

interface ModelsJsonConfig {
  providers: Record<string, CustomProviderConfig>;
}

/** Default location of mikan's models.json. */
export function defaultModelsJsonPath(): string {
  return join(homedir(), ".mikan", "models.json");
}

function parseModelsJson(path: string): ModelsJsonConfig | undefined {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error("models.json must be a JSON object");
  }
  const providers = (parsed as { providers?: unknown }).providers;
  if (providers === undefined) return undefined;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    throw new Error('models.json "providers" must be an object');
  }
  for (const [name, config] of Object.entries(providers)) {
    if (!config || typeof config !== "object") {
      throw new Error(`models.json provider "${name}" must be an object`);
    }
    const models = (config as CustomProviderConfig).models;
    if (models !== undefined) {
      if (!Array.isArray(models)) {
        throw new Error(`models.json provider "${name}" models must be an array`);
      }
      const api = (config as CustomProviderConfig).api;
      if (typeof api !== "string" || !(api in CUSTOM_API_STREAMS)) {
        throw new Error(
          `models.json provider "${name}" needs an "api" of: ${Object.keys(CUSTOM_API_STREAMS).join(", ")}`,
        );
      }
      for (const model of models) {
        if (!model || typeof model !== "object" || typeof model.id !== "string") {
          throw new Error(`models.json provider "${name}" has a model without a string "id"`);
        }
      }
    }
  }
  return parsed as ModelsJsonConfig;
}

function envVarNameFor(providerName: string): string {
  return `${providerName.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}_API_KEY`;
}

function buildCustomProvider(providerName: string, config: CustomProviderConfig): Provider {
  const api = config.api!;
  const displayName = config.name ?? providerName;
  const envVar = envVarNameFor(providerName);
  const models = (config.models ?? []).map((modelConfig): Model<Api> => {
    const model: Model<Api> = {
      id: modelConfig.id,
      name: modelConfig.name ?? modelConfig.id,
      api: (modelConfig.api ?? api) as Api,
      provider: providerName,
      baseUrl: modelConfig.baseUrl ?? config.baseUrl ?? "",
      reasoning: modelConfig.reasoning ?? false,
      input: modelConfig.input ?? ["text"],
      cost: modelConfig.cost ?? DEFAULT_COST,
      contextWindow: modelConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: modelConfig.maxTokens ?? modelConfig.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (modelConfig.thinkingLevelMap) model.thinkingLevelMap = modelConfig.thinkingLevelMap;
    if (modelConfig.headers ?? config.headers) {
      model.headers = { ...config.headers, ...modelConfig.headers };
    }
    const compat = modelConfig.compat ?? config.compat;
    if (compat) model.compat = compat as Model<Api>["compat"];
    return model;
  });

  return createProvider({
    id: providerName,
    name: displayName,
    baseUrl: config.baseUrl,
    headers: config.headers,
    auth: {
      apiKey: {
        name: `${displayName} API key`,
        resolve: async ({ ctx, credential }) => {
          const key =
            (credential?.type === "api_key" ? credential.key : undefined) ??
            config.apiKey ??
            (await ctx.env(envVar));
          if (!key) return undefined;
          const source =
            credential?.type === "api_key" && credential.key
              ? "auth.json"
              : config.apiKey
                ? "models.json"
                : envVar;
          return { auth: { apiKey: key }, source };
        },
      },
    },
    models,
    api: CUSTOM_API_STREAMS[api](),
  });
}

/** Rebuild a built-in provider with overridden model base URLs / compat. */
function overrideBuiltinProvider(provider: Provider, config: CustomProviderConfig): Provider {
  const models = provider.getModels().map((model): Model<Api> => {
    const overridden: Model<Api> = Object.assign({}, model);
    if (config.baseUrl) overridden.baseUrl = config.baseUrl;
    if (config.compat) overridden.compat = config.compat as Model<Api>["compat"];
    return overridden;
  });
  return {
    ...provider,
    getModels: () => models,
  };
}

export interface CreateMikanModelsOptions {
  authPath?: string;
  modelsJsonPath?: string;
}

/**
 * Model catalog backed by pi-ai's `Models`. Exposes the lookup and auth
 * operations mikan needs; streaming goes through {@link MikanModels.models}.
 */
export class MikanModels {
  /** Underlying pi-ai collection, for streaming/completion calls. */
  readonly models: Models;
  private loadError: string | undefined;

  private constructor(models: MutableModels, loadError: string | undefined) {
    this.models = models;
    this.loadError = loadError;
  }

  static create(options: CreateMikanModelsOptions = {}): MikanModels {
    const authPath = options.authPath ?? defaultAuthPath();
    const modelsJsonPath = options.modelsJsonPath ?? defaultModelsJsonPath();
    const models = builtinModels({ credentials: new FileCredentialStore(authPath) });

    let loadError: string | undefined;
    if (existsSync(modelsJsonPath)) {
      try {
        const config = parseModelsJson(modelsJsonPath);
        for (const [providerName, providerConfig] of Object.entries(config?.providers ?? {})) {
          if (providerConfig.models && providerConfig.models.length > 0) {
            models.setProvider(buildCustomProvider(providerName, providerConfig));
          } else if (providerConfig.baseUrl || providerConfig.compat) {
            const builtin = models.getProvider(providerName);
            if (builtin) {
              models.setProvider(overrideBuiltinProvider(builtin, providerConfig));
            }
          }
        }
      } catch (err) {
        loadError = `Failed to load ${modelsJsonPath}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return new MikanModels(models, loadError);
  }

  /** Error from loading models.json, if any. Built-in models stay available. */
  getError(): string | undefined {
    return this.loadError;
  }

  /** All known models (built-in plus custom). */
  getAll(): Model<Api>[] {
    return [...this.models.getModels()];
  }

  /** Find a model by provider and id. */
  find(provider: string, modelId: string): Model<Api> | undefined {
    return this.models.getModel(provider, modelId);
  }

  /** Models whose provider auth currently resolves (API key, OAuth, or ambient). */
  async getAvailable(): Promise<Model<Api>[]> {
    const byProvider = new Map<string, Model<Api>[]>();
    for (const model of this.models.getModels()) {
      const group = byProvider.get(model.provider) ?? [];
      group.push(model);
      byProvider.set(model.provider, group);
    }

    const available: Model<Api>[] = [];
    for (const group of byProvider.values()) {
      try {
        const auth = await this.models.getAuth(group[0]);
        if (auth) available.push(...group);
      } catch {
        // Auth resolution failure (e.g. expired OAuth) — treat as unavailable.
      }
    }
    return available;
  }

  /** Resolve request auth for a model. Undefined when unconfigured. */
  getAuth(model: Model<Api>): Promise<AuthResult | undefined> {
    return this.models.getAuth(model);
  }

  /**
   * Resolve an API key for a provider. Convenience for call sites that only
   * need a bearer key (for example pi-agent-core's compat stream function).
   */
  async getApiKeyForProvider(provider: string): Promise<string | undefined> {
    const model = this.models.getModels(provider)[0];
    if (!model) return undefined;
    try {
      const auth = await this.models.getAuth(model);
      return auth?.auth.apiKey;
    } catch {
      return undefined;
    }
  }
}
