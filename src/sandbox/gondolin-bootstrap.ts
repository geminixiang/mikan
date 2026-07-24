import { join } from "node:path";
import type { ResourceLimits } from "../types.js";
import { gondolinResources } from "./gondolin.js";
import { gondolinInventory } from "./gondolin-inventory.js";

export interface GondolinBootstrapOptions {
  /** Host-only state dir; runtime inventory lives under it. */
  stateDir: string;
  /** Default per-runtime resource limits. */
  limits?: ResourceLimits;
  /** Boosted limits applied while a runtime holds a boost. */
  boostLimits?: ResourceLimits;
}

/** Configure local Gondolin resources and detached-runtime inventory. */
export function configureGondolinRuntime(options: GondolinBootstrapOptions): void {
  gondolinResources.configure(options.limits, options.boostLimits);
  gondolinInventory.configure(join(options.stateDir, "gondolin-runtimes"));
}
