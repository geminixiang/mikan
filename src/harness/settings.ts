/**
 * Runtime settings for the mikan harness. mikan runs headless, so these are
 * plain values with defaults matching the behavior mikan shipped with.
 */
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
import type { CompactionSettings } from "@earendil-works/pi-agent-core";

export type { CompactionSettings };

export interface RetrySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
}

export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
};

export interface HarnessSettings {
  compaction: CompactionSettings;
  retry: RetrySettings;
}

export function resolveHarnessSettings(overrides?: {
  compaction?: Partial<CompactionSettings>;
  retry?: Partial<RetrySettings>;
}): HarnessSettings {
  return {
    compaction: { ...DEFAULT_COMPACTION_SETTINGS, ...overrides?.compaction },
    retry: { ...DEFAULT_RETRY_SETTINGS, ...overrides?.retry },
  };
}
