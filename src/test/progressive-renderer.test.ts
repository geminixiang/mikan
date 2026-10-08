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
    delete?: (id: string) => Promise<void>;
    needsCanonicalRender?: (text: string) => boolean;
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
    delete: async (id) => {
      calls.push({ operation: "delete", id });
      await overrides.delete?.(id);
    },
    needsCanonicalRender: overrides.needsCanonicalRender,
    showsPartialAnswer: kind === "buffered",
    stream:
      kind === "native"
        ? {
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
    await responder.replaceResponse("final", { final: true });

    expect(
      calls.some(
        (call) =>
          (call.operation === "post" || call.operation === "start") &&
          call.text === (kind === "buffered" ? "draft ..." : "draft"),
      ),
    ).toBe(true);
    expect(calls.filter((call) => call.operation === "post")).toHaveLength(
      kind === "buffered" ? 1 : 0,
    );
    expect(calls.filter((call) => call.operation === "delete")).toEqual([]);
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
    await responder.setWorking(false);
    await responder.setWorking(true);

    const visibleTexts = calls
      .filter((call) => ["post", "update", "start"].includes(call.operation))
      .map((call) => call.text);
    expect(visibleTexts).toEqual(
      kind === "buffered" ? ["progress ...", "progress", "progress ..."] : ["progress"],
    );
  });

  test("writes the final answer once, so ending the work changes nothing", async () => {
    const { responder, calls } = makeRenderer(kind);

    await responder.replaceResponse("progress");
    await responder.replaceResponse("progress\n\nanswer", { final: true });
    const writes = calls.length;
    await responder.setWorking(false);

    expect(calls).toHaveLength(writes);
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

  expect(calls[0]?.operation).toBe("post");
  expect(calls[0]?.text?.length).toBeLessThanOrEqual(20);
  expect(calls[1]?.operation).toBe("extra");
});

describe("one view, one writer", () => {
  test("a final write Slack rejects is retried when the work ends, without the indicator", async () => {
    let rejectFinal = true;
    const { responder, calls } = makeRenderer("buffered", undefined, {
      update: async (_id, text) => {
        if (rejectFinal && text === "answer") throw new Error("block_mismatch");
      },
    });
    await responder.replaceResponse("draft");
    await expect(responder.replaceResponse("answer", { final: true })).rejects.toThrow(
      "block_mismatch",
    );
    rejectFinal = false;

    await responder.setWorking(false);

    expect(calls.at(-1)).toMatchObject({ operation: "update", text: "answer" });
  });

  test("an unchanged view is not written again", async () => {
    const { responder, calls } = makeRenderer("buffered");

    await responder.replaceResponse("same");
    await responder.replaceResponse("same");

    expect(calls).toEqual([{ operation: "post", id: "message-1", text: "same ..." }]);
  });

  test("a native stream that no longer fits is stopped and its message updated, not deleted", async () => {
    const { responder, calls } = makeRenderer("native");

    await responder.replaceResponse("I check");
    await responder.replaceResponse("• a\n\nI check");
    await responder.replaceResponse("✓ a\n\ndone", { final: true });

    expect(calls.map((call) => call.operation)).toEqual(["start", "stop", "update", "update"]);
    expect(new Set(calls.map((call) => call.id)).size).toBe(1);
  });

  test("a final answer that extends the stream ends it without rewriting the message", async () => {
    const { responder, calls } = makeRenderer("native");

    await responder.replaceResponse("first half");
    await responder.replaceResponse("first half, second half", { final: true });

    expect(calls).toEqual([
      { operation: "start", id: "stream-1", text: "first half" },
      { operation: "append", id: "stream-1", text: ", second half" },
      { operation: "stop", id: "stream-1" },
    ]);
  });

  test("a streamed final answer that needs block rendering is rewritten once", async () => {
    const { responder, calls } = makeRenderer("native", undefined, {
      needsCanonicalRender: () => true,
    });

    await responder.replaceResponse("| a |");
    await responder.replaceResponse("| a |", { final: true });

    expect(calls.map((call) => call.operation)).toEqual(["start", "stop", "update"]);
  });
});

describe("redraw pacing", () => {
  test("views within the interval collapse into one later write of the latest view", async () => {
    vi.useFakeTimers();
    try {
      const { responder, calls } = makeRenderer("buffered", undefined, { flushIntervalMs: 1000 });

      await responder.replaceResponse("a");
      for (const text of ["ab", "abc", "abcd"]) {
        vi.advanceTimersByTime(100);
        await responder.replaceResponse(text);
      }
      expect(calls.map((call) => call.text)).toEqual(["a ..."]);

      await vi.advanceTimersByTimeAsync(1000);

      expect(calls.map((call) => call.text)).toEqual(["a ...", "abcd ..."]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("failed redraws remain paced and a later write carries the latest view", async () => {
    vi.useFakeTimers();
    try {
      let reject = true;
      const { responder, calls } = makeRenderer("buffered", "anchor", {
        flushIntervalMs: 1000,
        update: async () => {
          if (reject) throw new Error("block_mismatch");
        },
      });
      await responder.replaceResponse("a");
      vi.advanceTimersByTime(100);
      await responder.replaceResponse("ab");
      expect(calls).toHaveLength(1);

      reject = false;
      await vi.advanceTimersByTimeAsync(1000);

      expect(calls.at(-1)?.text).toBe("ab ...");
    } finally {
      vi.useRealTimers();
    }
  });

  test("the final view is written at once and cancels a pending redraw", async () => {
    vi.useFakeTimers();
    try {
      const { responder, calls } = makeRenderer("buffered", undefined, { flushIntervalMs: 1000 });

      await responder.replaceResponse("a");
      await responder.replaceResponse("ab");
      await responder.replaceResponse("abc", { final: true });
      await vi.advanceTimersByTimeAsync(5000);

      expect(calls.map((call) => call.text)).toEqual(["a ...", "abc"]);
    } finally {
      vi.useRealTimers();
    }
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

  test("a later redraw does not undo the preparation", async () => {
    const { responder, calls } = makeRenderer("buffered", undefined, {
      prepareSource: (text) => text.replace("RAW", "PREPARED"),
    });

    await responder.replaceResponse("is RAW");
    await responder.replaceResponse("is RAW, too");

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
      await responder.replaceResponse(String(round).repeat(50));
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
    await responder.replaceResponse("y".repeat(50));
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
    await expect(responder.replaceResponse("final", { final: true })).rejects.toThrow(
      "final rejected",
    );
    failing = false;
    await expect(responder.replaceResponse("recovered", { final: true })).resolves.toBeUndefined();
  });
});
