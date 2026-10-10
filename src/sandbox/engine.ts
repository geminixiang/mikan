import { readEnv } from "../env-manifest.js";

const DEFAULT_CONTAINER_ENGINE = "docker";

export function containerEngine(): string {
  return readEnv("CONTAINER_ENGINE") ?? DEFAULT_CONTAINER_ENGINE;
}
