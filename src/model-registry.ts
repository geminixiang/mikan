import { type Api, type Model, type Models } from "@earendil-works/pi-ai";

export function resolveConfiguredModel(
  models: Models,
  provider: string,
  modelId: string,
): Model<Api> {
  const model = models.getModel(provider, modelId);
  if (model) return model;

  throw new Error(
    `Unknown model "${provider}/${modelId}". Configure it in pi models.json or choose a registered model.`,
  );
}
