import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, Models, MutableModels, ProviderHeaders } from "@earendil-works/pi-ai";
import { FileCredentialStore, MIKAN_AUTH_PATH } from "./credential-store.js";

export type { Models } from "@earendil-works/pi-ai";

/** Provider/model catalog + auth resolution, replacing pi-coding-agent's ModelRegistry/AuthStorage. */
export function createMikanModels(authPath: string = MIKAN_AUTH_PATH): MutableModels {
  return builtinModels({ credentials: new FileCredentialStore(authPath) });
}

/** Replaces ModelRegistry.getAvailable() — models with resolvable auth. Now async (getAuth() is async). */
export async function getAvailableModels(models: Models): Promise<Model<Api>[]> {
  const all = models.getModels();
  const withAuth = await Promise.all(
    all.map(async (model) => ({ model, auth: await models.getAuth(model).catch(() => undefined) })),
  );
  return withAuth.filter((entry) => entry.auth !== undefined).map((entry) => entry.model);
}

/** Replaces ModelRegistry.getApiKeyForProvider(provider). Resolves auth through any model of that provider. */
export async function getApiKeyForProvider(
  models: Models,
  provider: string,
): Promise<string | undefined> {
  const providerModels = models.getModels(provider);
  if (providerModels.length === 0) return undefined;
  const auth = await models.getAuth(providerModels[0]).catch(() => undefined);
  return auth?.auth.apiKey;
}

export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: ProviderHeaders }
  | { ok: false; error: string };

/** Replaces ModelRegistry.getApiKeyAndHeaders(model). */
export async function getApiKeyAndHeaders(
  models: Models,
  model: Model<Api>,
): Promise<ResolvedRequestAuth> {
  try {
    const auth = await models.getAuth(model);
    if (!auth) {
      return {
        ok: false,
        error: `No API key for provider "${model.provider}". Set the appropriate environment variable or configure via auth.json`,
      };
    }
    return { ok: true, apiKey: auth.auth.apiKey, headers: auth.auth.headers };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
