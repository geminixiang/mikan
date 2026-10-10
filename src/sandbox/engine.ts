import { spawnSync } from "node:child_process";
import { readEnv } from "../env-manifest.js";

const CONTAINER_ENGINE_PRIORITY = ["nerdctl", "podman", "docker"] as const;

const ENGINE_PROBE_TIMEOUT_MS = 15_000;

export type EngineState = "running" | "installed" | "missing";

function probeEngine(engine: string): EngineState {
  const result = spawnSync(engine, ["info"], { stdio: "ignore", timeout: ENGINE_PROBE_TIMEOUT_MS });
  if (result.error && "code" in result.error && result.error.code === "ENOENT") return "missing";
  return result.status === 0 ? "running" : "installed";
}

export function detectContainerEngine(
  probe: (engine: string) => EngineState = probeEngine,
): string {
  let firstInstalled: string | undefined;
  for (const engine of CONTAINER_ENGINE_PRIORITY) {
    const state = probe(engine);
    if (state === "running") return engine;
    if (state === "installed") firstInstalled ??= engine;
  }
  return firstInstalled ?? "docker";
}

let detected: string | undefined;

export function containerEngine(): string {
  const configured = readEnv("CONTAINER_ENGINE");
  if (configured) return configured;
  detected ??= detectContainerEngine();
  return detected;
}
