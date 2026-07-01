/**
 * Auto-compaction policy: decides *when* to compact and persists the result.
 *
 * The decision logic (overflow vs. threshold) mirrors pi-coding-agent's
 * `AgentSession._checkCompaction`, but the actual token math and summary
 * generation are pi-agent-core's own exported primitives — nothing here is
 * hand-rolled beyond the "when" policy.
 */
import {
  calculateContextTokens,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  type Agent,
  type CompactionSettings,
  type SessionTreeEntry,
} from "@earendil-works/pi-agent-core";
import { isContextOverflow, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import type { SessionManager } from "./session-manager.js";

/** `CompactionResult` isn't re-exported from pi-agent-core's package entrypoint, so it's inlined here. */
export interface CompactionOutcome {
  compacted: boolean;
  reason?: "overflow" | "threshold";
  result?: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown };
}

/**
 * Check whether the session needs compaction and run it if so. Mutates
 * `agent.state.messages` in place when compaction runs.
 */
export async function checkCompaction(
  agent: Agent,
  sessionManager: SessionManager,
  models: Models,
  settings: CompactionSettings = DEFAULT_COMPACTION_SETTINGS,
  onStart?: (reason: "overflow" | "threshold") => void | Promise<void>,
): Promise<CompactionOutcome> {
  if (!settings.enabled) return { compacted: false };

  const messages = agent.state.messages;
  const lastAssistant = messages
    .toReversed()
    .find((m): m is AssistantMessage => m.role === "assistant");
  if (!lastAssistant) return { compacted: false };

  const model = agent.state.model;
  const contextWindow = model?.contextWindow ?? 0;
  const overflow = isContextOverflow(lastAssistant, contextWindow);

  let shouldRun = overflow;
  if (!overflow) {
    const directTokens = lastAssistant.usage ? calculateContextTokens(lastAssistant.usage) : 0;
    const contextTokens =
      lastAssistant.stopReason === "error" || directTokens === 0
        ? estimateContextTokens(messages).tokens
        : directTokens;
    shouldRun = shouldCompact(contextTokens, contextWindow, settings);
  }
  if (!shouldRun || !model) return { compacted: false };
  const reason = overflow ? "overflow" : "threshold";
  await onStart?.(reason);

  // mikan's SessionEntry is a structural superset of pi-agent-core's
  // SessionTreeEntry (same base shape); getBranch() never returns the
  // session header, so the cast is safe.
  const branch = sessionManager.getBranch() as unknown as SessionTreeEntry[];
  const preparationResult = prepareCompaction(branch, settings);
  if (!preparationResult.ok || !preparationResult.value) return { compacted: false, reason };

  const compactResult = await compact(preparationResult.value, models, model);
  if (!compactResult.ok) return { compacted: false, reason };

  const { summary, firstKeptEntryId, tokensBefore, details } = compactResult.value;
  sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details);
  agent.state.messages = sessionManager.buildSessionContext().messages;

  return { compacted: true, reason, result: compactResult.value };
}
