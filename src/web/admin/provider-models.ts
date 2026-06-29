import { createHash } from "crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../../harness/model-registry.js";

type AdminModelStatus = "available" | "unverified";

interface AdminModelAccessStatus {
  status: AdminModelStatus;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 3000;

interface ProviderModelsCacheEntry {
  expiresAt: number;
  modelIds: Set<string>;
}

const providerModelsCache = new Map<string, ProviderModelsCacheEntry>();

export async function resolveAdminModelAccessStatuses(
  registry: ModelRegistry,
  models: Model<Api>[],
): Promise<Map<string, AdminModelAccessStatus>> {
  const result = new Map<string, AdminModelAccessStatus>();
  const byProvider = groupModelsByProvider(models);

  await Promise.all(
    [...byProvider.entries()].map(async ([provider, providerModels]) => {
      const providerModelIds = await fetchProviderModelIds(registry, provider);
      for (const model of providerModels) {
        result.set(modelKey(model.provider, model.id), {
          status: modelIsListed(providerModelIds, model.id) ? "available" : "unverified",
        });
      }
    }),
  );

  return result;
}

export function modelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

function groupModelsByProvider(models: Model<Api>[]): Map<string, Model<Api>[]> {
  const groups = new Map<string, Model<Api>[]>();
  for (const model of models) {
    const group = groups.get(model.provider) ?? [];
    group.push(model);
    groups.set(model.provider, group);
  }
  return groups;
}

async function fetchProviderModelIds(
  registry: ModelRegistry,
  provider: string,
): Promise<Set<string> | undefined> {
  if (provider !== "openai" && provider !== "anthropic") return new Set<string>();

  const apiKey = await registry.getApiKeyForProvider(provider);
  if (!apiKey) return new Set<string>();

  const cacheKey = `${provider}:${hashApiKey(apiKey)}`;
  const cached = providerModelsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.modelIds;

  try {
    const modelIds =
      provider === "openai"
        ? await fetchOpenAiModelIds(apiKey)
        : await fetchAnthropicModelIds(apiKey);
    providerModelsCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      modelIds,
    });
    return modelIds;
  } catch {
    return undefined;
  }
}

async function fetchOpenAiModelIds(apiKey: string): Promise<Set<string>> {
  const response = await fetchWithTimeout("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`OpenAI models request failed: ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  return new Set((body.data ?? []).map((model) => model.id).filter(isString));
}

async function fetchAnthropicModelIds(apiKey: string): Promise<Set<string>> {
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/models", {
    headers: {
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    },
  });
  if (!response.ok) throw new Error(`Anthropic models request failed: ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  return new Set((body.data ?? []).map((model) => model.id).filter(isString));
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function modelIsListed(
  providerModelIds: Set<string> | undefined,
  registryModelId: string,
): boolean {
  return providerModelIds
    ? providerModelIds.size === 0 || providerModelIds.has(registryModelId)
    : false;
}

function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
