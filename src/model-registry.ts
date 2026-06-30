import { type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry } from "./harness/model-registry.js";

export function resolveConfiguredModel(
  modelRegistry: ModelRegistry,
  provider: string,
  modelId: string,
): Model<Api> {
  const model = modelRegistry.find(provider, modelId) as Model<Api> | undefined;
  if (model) return model;

  throw new Error(
    `Unknown model "${provider}/${modelId}". Configure it in mikan models.json or choose a registered model.`,
  );
}
