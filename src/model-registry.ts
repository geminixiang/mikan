import { type Api, type Model } from "@earendil-works/pi-ai";
import type { MikanModels } from "./harness/index.js";

export function resolveConfiguredModel(
  modelRegistry: MikanModels,
  provider: string,
  modelId: string,
): Model<Api> {
  const model = modelRegistry.find(provider, modelId);
  if (model) return model;

  throw new Error(
    `Unknown model "${provider}/${modelId}". Configure it in pi models.json or choose a registered model.`,
  );
}
