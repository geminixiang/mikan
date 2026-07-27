/**
 * Runtime settings for the mikan harness. mikan runs headless, so these are
 * plain values with defaults matching the behavior mikan shipped with.
 */
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import type { CompactionSettings } from "@earendil-works/pi-agent-core";
import type { BudgetSettings, HarnessSettings, RetrySettings } from "./types.js";

export type { CompactionSettings };
export type { BudgetSettings, HarnessSettings, RetrySettings } from "./types.js";

export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
};

/**
 * Per-run resource ceilings — the harness's external circuit breakers.
 *
 * An LLM cannot reliably decide on its own when to stop (the halting problem),
 * so a runaway run has to be stopped from the outside. When any populated cap
 * is exceeded, the run is aborted and a `budget_exceeded` event is emitted.
 * Every field is a cap on a single `prompt()` call; an undefined field means
 * "no cap on that axis". Interactive runs are gated turn-by-turn by a human,
 * so they default to uncapped; autonomous runs (scheduled events, triggers)
 * pass {@link DEFAULT_EVENT_BUDGET}, where nobody is watching the loop.
 */
/** Interactive runs are human-gated per turn — no automatic ceiling by default. */
export const DEFAULT_BUDGET_SETTINGS: BudgetSettings = {};

/**
 * Ceiling for autonomous (event / trigger) runs, where no human is watching
 * the loop. Deliberately generous — it is a stop-loss, not a target.
 */
export const DEFAULT_EVENT_BUDGET: BudgetSettings = {
  maxDurationMs: 10 * 60 * 1000,
  maxLlmCalls: 50,
  maxCostUsd: 10,
};

export function resolveHarnessSettings(overrides?: {
  compaction?: Partial<CompactionSettings>;
  retry?: Partial<RetrySettings>;
  budget?: Partial<BudgetSettings>;
}): HarnessSettings {
  return {
    compaction: { ...DEFAULT_COMPACTION_SETTINGS, ...overrides?.compaction },
    retry: { ...DEFAULT_RETRY_SETTINGS, ...overrides?.retry },
    budget: { ...DEFAULT_BUDGET_SETTINGS, ...overrides?.budget },
  };
}
