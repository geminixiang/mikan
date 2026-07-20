import type { PlatformName } from "../adapter.js";
import type { SandboxConfig } from "../sandbox/index.js";
import { assertGondolinRemotePlatformIsolation } from "../sandbox/identity.js";
import type { ConversationStorageCompletionRecord } from "./types.js";

/** Validate scoped-mode support before sandbox/gateway or bot side effects. */
export function assertConversationStorageStartup(options: {
  sandbox: SandboxConfig;
  activePlatforms: readonly PlatformName[];
  completion?: ConversationStorageCompletionRecord;
}): void {
  assertGondolinRemotePlatformIsolation(
    options.sandbox,
    [...options.activePlatforms],
    options.completion !== undefined,
  );
}
