/**
 * v3 → v4 session-entry conversion at the pi-agent-core call boundary.
 *
 * Mikan session files stay in the v3 layout (string timestamps, compaction
 * entries that point at `firstKeptEntryId`). pi-agent-core 0.84 moved to a
 * v4 entry model: numeric timestamps, a required `seq`, and compaction
 * entries that carry their retained messages inline (`retainedTail`). This
 * module converts a v3 branch into an equivalent v4 entry list so pi's
 * context builder and compaction pipeline keep operating on mikan sessions.
 *
 * Equivalence with the v3 (pi 0.83) context semantics:
 * - a compaction with `firstKeptEntryId` is repositioned to just before its
 *   first kept entry with an empty `retainedTail`, so pi's v4 transform
 *   (drop everything before the last compaction, then emit summary +
 *   retainedTail + following entries) reproduces the v3 result exactly;
 * - `custom_message` entries become v4 message entries carrying pi's
 *   `custom` message role, which is how v3 rendered them into context;
 * - `session_info`, `label`, and `leaf` entries contribute nothing to
 *   context or state and are dropped.
 */
import { createCustomMessage, type Entry as PiEntry } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "./types.js";

function toEpochMillis(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Convert one v3 entry to its v4 counterpart, or null when it has none. */
function convertEntry(entry: SessionEntry): PiEntry | null {
  const base = {
    id: entry.id,
    // seq/parentId are rewritten by relink() once the final order is known.
    seq: 0,
    parentId: null,
    timestamp: toEpochMillis(entry.timestamp),
  };
  switch (entry.type) {
    case "message":
      return { ...base, type: "message", message: entry.message };
    case "custom_message":
      return {
        ...base,
        type: "message",
        message: createCustomMessage(
          entry.customType,
          entry.content,
          entry.display,
          entry.details,
          entry.timestamp,
        ),
      };
    case "thinking_level_change":
      return { ...base, type: "thinking_level_change", thinkingLevel: entry.thinkingLevel };
    case "model_change":
      return { ...base, type: "model_change", provider: entry.provider, modelId: entry.modelId };
    case "active_tools_change":
      return { ...base, type: "active_tools_change", activeToolNames: entry.activeToolNames };
    case "compaction":
      return {
        ...base,
        type: "compaction",
        summary: entry.summary,
        retainedTail: entry.retainedTail ?? [],
        tokensBefore: entry.tokensBefore,
        ...(entry.details !== undefined ? { details: entry.details } : {}),
        ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
      };
    case "branch_summary":
      return {
        ...base,
        type: "branch_summary",
        fromId: entry.fromId,
        summary: entry.summary,
        ...(entry.details !== undefined ? { details: entry.details } : {}),
        ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
      };
    case "custom":
      return { ...base, type: "custom", customType: entry.customType, data: entry.data };
    default:
      return null;
  }
}

function relink(entries: PiEntry[]): PiEntry[] {
  let previousId: string | null = null;
  for (const [index, entry] of entries.entries()) {
    entry.seq = index;
    entry.parentId = previousId;
    previousId = entry.id;
  }
  return entries;
}

/**
 * Convert a v3 branch (root-first path order, as returned by
 * `SessionStore.getBranch`) into v4 entries with equivalent context
 * semantics. Entry ids are preserved, so results from pi (for example a
 * compaction cut point) can be mapped back to v3 entries.
 */
export function toPiEntries(branch: readonly SessionEntry[]): PiEntry[] {
  let lastCompactionIndex = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]?.type === "compaction") {
      lastCompactionIndex = i;
      break;
    }
  }

  const lastCompaction =
    lastCompactionIndex === -1 ? undefined : (branch[lastCompactionIndex] as SessionEntry);
  const firstKeptId =
    lastCompaction?.type === "compaction" && !lastCompaction.retainedTail
      ? lastCompaction.firstKeptEntryId
      : undefined;
  const firstKeptIndex =
    firstKeptId === undefined ? -1 : branch.findIndex((entry) => entry.id === firstKeptId);

  const converted: PiEntry[] = [];
  const pushConverted = (entry: SessionEntry) => {
    const piEntry = convertEntry(entry);
    if (piEntry) converted.push(piEntry);
  };

  if (firstKeptIndex !== -1 && lastCompactionIndex !== -1) {
    // Reposition the compaction ahead of its kept range so pi's v4
    // last-compaction transform keeps exactly the v3 kept entries.
    for (const entry of branch.slice(0, firstKeptIndex)) pushConverted(entry);
    pushConverted(branch[lastCompactionIndex] as SessionEntry);
    for (const [index, entry] of branch.entries()) {
      if (index >= firstKeptIndex && index !== lastCompactionIndex) pushConverted(entry);
    }
  } else {
    for (const entry of branch) pushConverted(entry);
  }

  return relink(converted);
}

/**
 * Find the entry id whose message became `retainedTail[0]` of a compaction
 * preparation built from `toPiEntries(branch)`. Ids are preserved by the
 * conversion and message objects are shared by identity, so the id maps
 * straight back to the v3 entry. Returns undefined for keep-nothing
 * compactions.
 */
export function findFirstKeptEntryId(
  piEntries: readonly PiEntry[],
  retainedTail: readonly unknown[],
): string | undefined {
  const firstRetained = retainedTail[0];
  if (firstRetained === undefined) return undefined;
  return piEntries.find((entry) => entry.type === "message" && entry.message === firstRetained)?.id;
}
