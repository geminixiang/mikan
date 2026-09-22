import { describe, expect, test, vi } from "vitest";
import { createProgressiveRenderer } from "../adapters/progressive-renderer.js";
import type { ProgressiveRendererPlatform } from "../adapters/types.js";

type StreamKind = "buffered" | "native";
interface Call {
  operation: string;
  id?: string;
  text?: string;
}

function makeRenderer(
  kind: StreamKind,
  initialResponseId?: string,
  overrides: {
    post?: (text: string) => Promise<string>;
    update?: (id: string, text: string) => Promise<void>;
    minDeltaChars?: number;
    flushIntervalMs?: number;
    prepareSource?: (text: string, working: boolean) => string;
  } = {},
) {
  const calls: Call[] = [];
  const responseErrorContext = vi.fn((responseId: string | null) => ({
    platform: kind,
    conversationId: "conversation",
    messageId: "message",
    sessionKey: "session",
    conversationKind: "shared",
    responseMessageId: responseId,
  }));
  let nextId = 1;
  const platform: ProgressiveRendererPlatform = {
    label: kind,
    maxLength: 20,
    flushIntervalMs: overrides.flushIntervalMs ?? 0,
    ...(overrides.prepareSource ? { prepareSource: overrides.prepareSource } : {}),
    initialResponseId,
    formatContinuation: (partNum) => `(continued ${partNum})`,
    errorPrefix: "Error: ",
    workingIndicator: kind === "buffered" ? " ..." : undefined,
    formatToolResult: () => "",
    responseErrorContext,
    post: async (text) => {
      const id = `message-${nextId++}`;
      calls.push({ operation: "post", id, text });
      return overrides.post ? overrides.post(text) : id;
    },
    update: async (id, text) => {
      calls.push({ operation: "update", id, text });
      await overrides.update?.(id, text);
    },
    postExtra: async (text, responseId) => {
      calls.push({ operation: "extra", id: responseId ?? undefined, text });
      return `extra-${nextId++}`;
    },
    supportsDeltas: kind === "buffered",
    stream:
      kind === "native"
        ? {
            ...(overrides.minDeltaChars !== undefined
              ? { minDeltaChars: overrides.minDeltaChars }
              : {}),
            start: async (text) => {
              const id = `stream-${nextId++}`;
              calls.push({ operation: "start", id, text });
              return id;
            },
            append: async (id, delta) => {
              calls.push({ operation: "append", id, text: delta });
            },
            stop: async (id) => {
              calls.push({ operation: "stop", id });
            },
          }
        : undefined,
  };
  return {
    calls,
    responseErrorContext,
    responder: createProgressiveRenderer(platform).responder,
  };
}

describe.each<StreamKind>(["buffered", "native"])("Progressive renderer contract: %s", (kind) => {
  test("preserves response identity across replacement and finalization", async () => {
    const { responder, calls } = makeRenderer(kind);

    await responder.respond("draft");
    await responder.replaceResponse("replacement");
    await responder.finishResponse?.("final");

    expect(calls.some((call) => call.operation === "post" && call.text?.includes("draft"))).toBe(
      kind === "buffered",
    );
    expect(calls.filter((call) => call.operation === "post")).toHaveLength(
      kind === "buffered" ? 1 : 0,
    );
    expect(calls.at(-1)).toMatchObject({ operation: "update", text: "final" });
    expect(new Set(calls.filter((call) => call.id).map((call) => call.id)).size).toBe(1);
  });

  test("does not write a bare working indicator for blank content", async () => {
    const { responder, calls } = makeRenderer(kind);

    await responder.respond(" \n");
    await responder.replaceResponse("\n\t");
    await responder.setWorking(true);

    expect(calls).toEqual([]);
  });

  test("keeps the working indicator out of canonical source", async () => {
    const { responder, calls } = makeRenderer(kind);

    await responder.replaceResponse("progress");
    await responder.setWorking(true);
    await responder.setWorking(false);
    await responder.setWorking(true);

    const visibleTexts = calls
      .filter((call) => call.operation === "post" || call.operation === "update")
      .map((call) => call.text);
    expect(visibleTexts.at(-2)).toBe("progress");
    expect(visibleTexts.at(-1)).toBe(kind === "buffered" ? "progress ..." : "progress");
    expect(visibleTexts.every((text) => !text?.includes("... ..."))).toBe(true);
  });

  test("serializes concurrent response operations", async () => {
    const { responder, calls } = makeRenderer(kind);

    await Promise.all([responder.respond("first"), responder.respond("second")]);

    const visibleTexts = calls
      .filter(
        (call) =>
          call.operation === "post" ||
          call.operation === "update" ||
          call.operation === "start" ||
          call.operation === "append",
      )
      .map((call) => call.text);
    expect(visibleTexts[0]).toContain("first");
    expect(visibleTexts.at(-1)).toContain("second");
  });
});

test("reports a transport failure once and recovers without rejecting callers", async () => {
  let attempts = 0;
  const { responder, calls, responseErrorContext } = makeRenderer("buffered", undefined, {
    post: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("send failed");
      return "recovered";
    },
  });

  await expect(responder.respond("first")).resolves.toBeUndefined();
  await expect(responder.respond("second")).resolves.toBeUndefined();

  expect(responseErrorContext).toHaveBeenCalledTimes(1);
  expect(responseErrorContext).toHaveBeenCalledWith(null);
  expect(calls.at(-1)).toMatchObject({ operation: "post", text: "first\nsecond ..." });
});

test("uses an existing response identity instead of posting a second message", async () => {
  const { responder, calls } = makeRenderer("buffered", "existing");

  await responder.respond("hello");

  expect(calls).toEqual([{ operation: "update", id: "existing", text: "hello ..." }]);
});

test("reports a failed update with the current response identity", async () => {
  const { responder, responseErrorContext } = makeRenderer("buffered", "existing", {
    update: async () => {
      throw new Error("update failed");
    },
  });

  await responder.respond("hello");

  expect(responseErrorContext).toHaveBeenCalledWith("existing");
});

test("splits buffered output before sending continuation messages", async () => {
  const { responder, calls } = makeRenderer("buffered");

  await responder.setWorking(false);
  await responder.respond("x".repeat(25));

  expect(calls[0].operation).toBe("post");
  expect(calls[0].text?.length).toBeLessThanOrEqual(20);
  expect(calls[1].operation).toBe("extra");
});

const chunk = (letter: string) => letter.repeat(100);

describe("native streaming: delta buffering", () => {
  test("withholds small deltas and flushes the remainder before stopping", async () => {
    const { responder, calls } = makeRenderer("native", undefined, { minDeltaChars: 300 });

    await responder.appendResponseDelta?.(chunk("a"));
    await responder.appendResponseDelta?.(chunk("b"));
    await responder.appendResponseDelta?.(chunk("c"));
    await responder.appendResponseDelta?.(chunk("d"));
    await responder.finishResponse?.();

    const started = calls.find((call) => call.operation === "start")?.text ?? "";
    const appends = calls.filter((call) => call.operation === "append").map((call) => call.text);

    expect(appends).toHaveLength(1);
    expect(appends[0]).toBe(chunk("b") + chunk("c") + chunk("d"));

    expect(started + appends.join("")).toBe(chunk("a") + chunk("b") + chunk("c") + chunk("d"));
    expect(calls.filter((call) => call.operation === "stop")).toHaveLength(1);
  });

  test("a delta still pending at the end is flushed, not lost", async () => {
    const { responder, calls } = makeRenderer("native", undefined, { minDeltaChars: 10_000 });

    await responder.appendResponseDelta?.(chunk("a"));
    await responder.appendResponseDelta?.(chunk("b"));
    await responder.finishResponse?.();

    const started = calls.find((call) => call.operation === "start")?.text ?? "";
    const appends = calls.filter((call) => call.operation === "append").map((call) => call.text);
    expect(started + appends.join("")).toBe(chunk("a") + chunk("b"));
    expect(calls.filter((call) => call.operation === "stop")).toHaveLength(1);
  });

  test("without a threshold every flush is forwarded", async () => {
    const { responder, calls } = makeRenderer("native");

    await responder.appendResponseDelta?.(chunk("a"));
    await responder.appendResponseDelta?.(chunk("b"));
    await responder.appendResponseDelta?.(chunk("c"));

    expect(calls.filter((call) => call.operation === "append").map((call) => call.text)).toEqual([
      chunk("b"),
      chunk("c"),
    ]);
  });
});

describe("redraw pacing", () => {
  test("failed redraws remain paced and later recovery retains all text", async () => {
    vi.useFakeTimers();
    try {
      let reject = true;
      const { responder, calls } = makeRenderer("buffered", "anchor", {
        flushIntervalMs: 1000,
        update: async () => {
          if (reject) throw new Error("block_mismatch");
        },
      });
      await responder.appendResponseDelta?.("a");
      for (const delta of ["b", "c", "d"]) {
        vi.advanceTimersByTime(100);
        await responder.appendResponseDelta?.(delta);
      }
      expect(calls).toHaveLength(1);
      reject = false;
      vi.advanceTimersByTime(1000);
      await responder.appendResponseDelta?.("e");
      expect(calls).toHaveLength(2);
      expect(calls[1]?.text).toBe("abcde ...");
      await responder.finishResponse?.("abcde");
      expect(calls.at(-1)?.text).toBe("abcde");
    } finally {
      vi.useRealTimers();
    }
  });
  test("volume alone does not trigger a redraw before the interval", async () => {
    vi.useFakeTimers();
    const { responder, calls } = makeRenderer("buffered", undefined, { flushIntervalMs: 1000 });

    for (let index = 0; index < 20; index++) {
      await responder.appendResponseDelta?.("0123456789".repeat(10));
    }

    expect(calls.filter((call) => call.operation === "update")).toHaveLength(0);
    expect(calls.filter((call) => call.operation === "post")).toHaveLength(1);
    vi.useRealTimers();
  });

  test("a redraw becomes due once the interval passes", async () => {
    vi.useFakeTimers();
    const { responder, calls } = makeRenderer("buffered", undefined, { flushIntervalMs: 1000 });

    await responder.appendResponseDelta?.("first");
    vi.advanceTimersByTime(1500);
    await responder.appendResponseDelta?.("second");

    expect(calls.filter((call) => call.operation === "update")).toHaveLength(1);
    vi.useRealTimers();
  });

  test("the interval is measured from when a redraw finished, not when it began", async () => {
    vi.useFakeTimers();
    const { responder, calls } = makeRenderer("buffered", undefined, {
      flushIntervalMs: 1000,
      update: async () => {
        vi.advanceTimersByTime(5000);
      },
    });

    await responder.appendResponseDelta?.("first");
    vi.advanceTimersByTime(1500);
    await responder.appendResponseDelta?.("second");
    await responder.appendResponseDelta?.("third");

    expect(calls.filter((call) => call.operation === "update")).toHaveLength(1);
    vi.useRealTimers();
  });
});

describe("source preparation", () => {
  test("the final replace renders prepared text, not the raw source", async () => {
    const { responder, calls } = makeRenderer("buffered", undefined, {
      prepareSource: (text) => text.replace("RAW", "PREPARED"),
    });

    await responder.replaceResponse("this is RAW");

    const sent = calls.map((call) => call.text).join("");
    expect(sent).toContain("PREPARED");
    expect(sent).not.toContain("RAW");
  });

  test("a replace after a delta does not undo the delta's preparation", async () => {
    const { responder, calls } = makeRenderer("buffered", undefined, {
      prepareSource: (text) => text.replace("RAW", "PREPARED"),
    });

    await responder.appendResponseDelta?.("this is RAW");
    await responder.replaceResponse("this is RAW");

    const last = calls.at(-1)?.text ?? "";
    expect(last).toContain("PREPARED");
    expect(last).not.toContain("RAW");
  });
});

describe("overflow messages", () => {
  test("a redraw edits the overflow instead of posting more", async () => {
    const { responder, calls } = makeRenderer("buffered");
    await responder.setWorking(false);

    await responder.replaceResponse("z".repeat(50));
    const afterFirst = calls.filter((call) => call.operation === "extra").length;
    expect(afterFirst).toBeGreaterThan(0);

    calls.length = 0;
    await responder.replaceResponse("y".repeat(50));

    expect(calls.filter((call) => call.operation === "extra")).toHaveLength(0);
    const edits = calls.filter(
      (call) => call.operation === "update" && call.id?.startsWith("extra"),
    );
    expect(edits).toHaveLength(afterFirst);
  });

  test("overflow count does not grow with the number of redraws", async () => {
    const { responder, calls } = makeRenderer("buffered");
    await responder.setWorking(false);

    await responder.replaceResponse("z".repeat(50));
    const created = calls.filter((call) => call.operation === "extra").length;
    for (let round = 0; round < 5; round++) {
      await responder.replaceResponse("z".repeat(50));
    }

    expect(calls.filter((call) => call.operation === "extra")).toHaveLength(created);
  });

  test("each overflow message keeps its own position", async () => {
    const { responder, calls } = makeRenderer("buffered");
    await responder.setWorking(false);
    await responder.replaceResponse("z".repeat(50));
    const firstIds = calls
      .filter((call) => call.operation === "extra")
      .map((_, index) => `extra-${index + 2}`);

    calls.length = 0;
    await responder.replaceResponse("z".repeat(50));
    const editedIds = calls
      .filter((call) => call.operation === "update" && call.id?.startsWith("extra"))
      .map((call) => call.id);

    expect(editedIds).toEqual(firstIds);
  });
});

describe.each<StreamKind>(["buffered", "native"])("required delivery: %s", (kind) => {
  test("replacement failure rejects but the next replacement can recover", async () => {
    let failing = true;
    const { responder } = makeRenderer(kind, "existing", {
      update: async () => {
        if (failing) throw new Error("final rejected");
      },
    });
    await expect(responder.replaceResponse("final")).rejects.toThrow("final rejected");
    failing = false;
    await expect(responder.replaceResponse("recovered")).resolves.toBeUndefined();
  });
});
