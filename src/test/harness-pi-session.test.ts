import { prepareCompaction, getOrThrow } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { findFirstKeptEntryId, toPiEntries } from "../harness/pi-session.js";
import { buildSessionContext } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "../harness/types.js";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function messageEntry(id: string, parentId: string | null, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: userMessage(text),
  };
}

function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        (part as { type?: string }).type === "text" ? (part as { text: string }).text : "",
      )
      .join("");
  }
  return "";
}

describe("toPiEntries", () => {
  test("branch without compaction converts messages in order", () => {
    const branch: SessionEntry[] = [messageEntry("a", null, "A"), messageEntry("b", "a", "B")];
    const context = buildSessionContext(toPiEntries(branch));
    expect(context.messages.map(textOf)).toEqual(["A", "B"]);
  });

  test("compaction with firstKeptEntryId reproduces v3 context semantics", () => {
    const branch: SessionEntry[] = [
      {
        type: "model_change",
        id: "m",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        provider: "test",
        modelId: "test-model",
      },
      messageEntry("a", "m", "A"),
      messageEntry("b", "a", "B"),
      messageEntry("c", "b", "C"),
      {
        type: "compaction",
        id: "comp",
        parentId: "c",
        timestamp: "2026-01-01T00:00:02.000Z",
        summary: "the summary",
        firstKeptEntryId: "b",
        tokensBefore: 100,
      },
      messageEntry("d", "comp", "D"),
    ];

    const context = buildSessionContext(toPiEntries(branch));
    expect(context.messages[0]?.role).toBe("compactionSummary");
    expect(context.messages.slice(1).map(textOf)).toEqual(["B", "C", "D"]);
    // State derives from the full path: a model_change before the kept
    // range must survive the compaction cut.
    expect(context.model).toEqual({ provider: "test", modelId: "test-model" });
  });

  test("custom_message entries participate in context as custom messages", () => {
    const branch: SessionEntry[] = [
      messageEntry("a", null, "A"),
      {
        type: "custom_message",
        id: "cm",
        parentId: "a",
        timestamp: "2026-01-01T00:00:01.000Z",
        customType: "note",
        content: "remember this",
        display: false,
      },
    ];
    const context = buildSessionContext(toPiEntries(branch));
    expect(context.messages).toHaveLength(2);
    expect(context.messages[1]?.role).toBe("custom");
  });

  test("prepareCompaction round-trip recovers a firstKeptEntryId on the branch", () => {
    const branch: SessionEntry[] = [];
    let parentId: string | null = null;
    for (let i = 0; i < 30; i++) {
      const id = `m${i}`;
      branch.push(messageEntry(id, parentId, `message ${i} ${"x".repeat(400)}`));
      parentId = id;
    }

    const piEntries = toPiEntries(branch);
    const preparation = getOrThrow(
      prepareCompaction(piEntries, {
        enabled: true,
        reserveTokens: 100,
        keepRecentTokens: 500,
      }),
    );
    expect(preparation).toBeDefined();
    if (!preparation) return;
    const firstKeptEntryId = findFirstKeptEntryId(piEntries, preparation.retainedTail);
    expect(firstKeptEntryId).toBeDefined();
    expect(branch.some((entry) => entry.id === firstKeptEntryId)).toBe(true);
  });

  test("findFirstKeptEntryId recovers a custom_message kept entry", () => {
    const branch: SessionEntry[] = [
      messageEntry("a", null, "A"),
      {
        type: "custom_message",
        id: "cm",
        parentId: "a",
        timestamp: "2026-01-01T00:00:01.000Z",
        customType: "note",
        content: "kept",
        display: false,
      },
    ];
    const piEntries = toPiEntries(branch);
    const keptEntry = piEntries[1];
    if (keptEntry?.type !== "message") throw new Error("expected message entry");
    expect(findFirstKeptEntryId(piEntries, [keptEntry.message])).toBe("cm");
  });
});
