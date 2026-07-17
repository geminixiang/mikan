import { join } from "node:path";
import type { GondolinRemoteSettings, ResourceLimits } from "../types.js";
import { assertRemoteConfigured, gondolinResources } from "./gondolin.js";
import { gondolinFleet } from "./gondolin-fleet.js";
import { gondolinGateway } from "./gondolin-gateway.js";
import { gondolinInventory } from "./gondolin-inventory.js";
import { gondolinJoin } from "./gondolin-join.js";
import { gondolinPlacements } from "./gondolin-placement.js";

export interface GondolinBootstrapOptions {
  /** Host-only state dir; inventory, placements, and gateway CA live under it. */
  stateDir: string;
  /** Default per-runtime resource limits. */
  limits?: ResourceLimits;
  /** Boosted limits applied while a runtime holds a boost. */
  boostLimits?: ResourceLimits;
  /** Remote fleet settings (workers, gateway); omit for local-only gondolin. */
  remote?: GondolinRemoteSettings;
  /**
   * Fail loudly when the remote profile is requested but no worker source is
   * configured, instead of discovering it on the first runtime ensure.
   */
  requireRemote?: boolean;
}

/**
 * Configure every gondolin runtime singleton for one process — resources,
 * inventory, placements, fleet, join, gateway — from one options object.
 * This is the managed-sandbox bootstrap seam: main.ts and embedders
 * (src/index.ts) call it before creating conversation runtimes with a
 * gondolin sandbox config; nothing else may call the individual configure()
 * methods outside tests.
 */
export function configureGondolinRuntime(options: GondolinBootstrapOptions): void {
  gondolinResources.configure(options.limits, options.boostLimits);
  gondolinInventory.configure(join(options.stateDir, "gondolin-runtimes"));
  gondolinPlacements.configure(join(options.stateDir, "gondolin-placement.json"));
  gondolinFleet.configure(options.remote);
  gondolinJoin.configure(join(options.stateDir, "gondolin-gateway"));
  gondolinGateway.configure(options.remote?.gateway);
  if (options.requireRemote) {
    assertRemoteConfigured();
  }
}
