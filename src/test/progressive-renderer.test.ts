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
