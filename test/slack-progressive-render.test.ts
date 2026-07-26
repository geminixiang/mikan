import { describe, expect, test } from "vitest";
import {
  SlackProgressiveRender,
  closeOpenFences,
  WORKING_INDICATOR,
  type SlackRenderOps,
} from "../src/adapters/slack/progressive-render.js";

interface OpCall {
  op: string;
  ts?: string;
  text?: string;
}

function makeOps(overrides: Partial<SlackRenderOps> = {}): {
  ops: SlackRenderOps;
  calls: OpCall[];
} {
  const calls: OpCall[] = [];
  let nextTs = 100;
  const ops: SlackRenderOps = {
    postMessage: async (_channel, text) => {
      calls.push({ op: "postMessage", text });
      return String(++nextTs);
    },
    postInThread: async (_channel, _threadTs, text) => {
      calls.push({ op: "postInThread", text });
      return String(++nextTs);
    },
    updateMessage: async (_channel, ts, text) => {
      calls.push({ op: "updateMessage", ts, text });
    },
    startMessageStream: async (_channel, text) => {
      calls.push({ op: "startStream", text });
      return String(++nextTs);
    },
    appendMessageStream: async (_channel, ts, text) => {
      calls.push({ op: "appendStream", ts, text });
    },
    stopMessageStream: async (_channel, ts) => {
      calls.push({ op: "stopStream", ts });
    },
    ...overrides,
  };
  return { ops, calls };
}

const TOP_LEVEL = { channelId: "C1", rootTs: "1.0", replyInThread: false };
const THREAD = { channelId: "C1", rootTs: "1.0", replyInThread: true };

describe("closeOpenFences", () => {
  test("returns balanced text unchanged", () => {
    const text = "before\n```\ncode\n```\nafter";
    expect(closeOpenFences(text)).toBe(text);
  });

  test("closes an unterminated fence", () => {
    expect(closeOpenFences("before\n```ts\nconst x = 1;")).toBe("before\n```ts\nconst x = 1;\n```");
  });

  test("closes tilde fences with tildes", () => {
    expect(closeOpenFences("~~~\ncode")).toBe("~~~\ncode\n~~~");
  });

  test("does not close a backtick fence with a tilde line", () => {
    expect(closeOpenFences("```\ncode\n~~~\nmore")).toBe("```\ncode\n~~~\nmore\n```");
  });
});

describe("SlackProgressiveRender — top-level (block update path)", () => {
  test("working renders do not post or update a bare indicator", async () => {
    const { ops, calls } = makeOps();
    const fresh = new SlackProgressiveRender(ops, TOP_LEVEL);
    const existing = new SlackProgressiveRender(ops, { ...TOP_LEVEL, initialMessageTs: "MSG" });

    await fresh.delta("\n", true);
    await fresh.replace(" ", true);
    await existing.delta("", true);
    await existing.replace("\n", true);
    await existing.setWorking(" ", true);

    expect(calls).toEqual([]);
  });

  test("first delta posts, later deltas update the same message", async () => {
    const { ops, calls } = makeOps();
    const render = new SlackProgressiveRender(ops, TOP_LEVEL);

    await render.delta("Hello", true);
    await render.delta("Hello world", true);
    await render.finish("Hello world done");

    expect(calls).toEqual([
      { op: "postMessage", text: `Hello${WORKING_INDICATOR}` },
      { op: "updateMessage", ts: "101", text: `Hello world${WORKING_INDICATOR}` },
      { op: "updateMessage", ts: "101", text: "Hello world done" },
    ]);
    expect(render.messageTs).toBe("101");
  });

  test("provisional renders auto-close an open fence; finish does not decorate", async () => {
    const { ops, calls } = makeOps();
    const render = new SlackProgressiveRender(ops, TOP_LEVEL);

    await render.delta("intro\n```ts\nlet x = 1;", true);
    await render.finish("intro\n```ts\nlet x = 1;\n```");

    expect(calls[0].text).toBe(`intro\n\`\`\`ts\nlet x = 1;\n\`\`\`${WORKING_INDICATOR}`);
    expect(calls[1].text).toBe("intro\n```ts\nlet x = 1;\n```");
  });

  test("msg_too_long from the block path propagates to the caller", async () => {
    const { ops } = makeOps({
      postMessage: async () => {
        throw new Error("An API error occurred: msg_too_long");
      },
    });
    const render = new SlackProgressiveRender(ops, TOP_LEVEL);
    await expect(render.delta("big", true)).rejects.toThrow("msg_too_long");
  });
});

describe("SlackProgressiveRender — thread (native stream path)", () => {
  test("streams deltas natively and finishes without canonical re-render", async () => {
    const { ops, calls } = makeOps();
    const render = new SlackProgressiveRender(ops, THREAD);

    await render.delta("Hello", true);
    await render.delta("Hello world", true);
    await render.finish("Hello world done");

    expect(calls).toEqual([
      { op: "startStream", text: "Hello" },
      { op: "appendStream", ts: "101", text: " world" },
      { op: "appendStream", ts: "101", text: " done" },
      { op: "stopStream", ts: "101" },
    ]);
  });

  test("finish re-renders canonically when the content needs a table block", async () => {
    const { ops, calls } = makeOps();
    const render = new SlackProgressiveRender(ops, THREAD);
    const withTable = "Data:\n\n| a | b |\n|---|---|\n| 1 | 2 |";

    await render.delta("Data:", true);
    await render.finish(withTable);

    expect(calls.map((call) => call.op)).toEqual([
      "startStream",
      "appendStream",
      "stopStream",
      "updateMessage",
    ]);
    expect(calls[3].text).toBe(withTable);
  });

  test("a non-extending delta abandons the stream and re-posts via blocks", async () => {
    const { ops, calls } = makeOps();
    const render = new SlackProgressiveRender(ops, THREAD);

    await render.delta("Hello world", true);
    await render.delta("Rewritten", true);
    await render.delta("Rewritten more", true);

    expect(calls).toEqual([
      { op: "startStream", text: "Hello world" },
      { op: "stopStream", ts: "101" },
      { op: "postInThread", text: `Rewritten${WORKING_INDICATOR}` },
      { op: "updateMessage", ts: "102", text: `Rewritten more${WORKING_INDICATOR}` },
    ]);
  });

  test("a stream API failure falls back to block updates for the whole response", async () => {
    const { ops, calls } = makeOps({
      startMessageStream: async () => {
        throw new Error("streams not enabled");
      },
    });
    const render = new SlackProgressiveRender(ops, THREAD);

    await render.delta("Hello", true);
    await render.delta("Hello world", true);

    expect(calls.map((call) => call.op)).toEqual(["postInThread", "updateMessage"]);
    expect(calls[0].text).toBe(`Hello${WORKING_INDICATOR}`);
  });

  test("whitespace replacement stops an active stream without clearing its message", async () => {
    const { ops, calls } = makeOps();
    const render = new SlackProgressiveRender(ops, THREAD);

    await render.delta("old", true);
    await render.replace(" ", true);

    expect(calls).toEqual([
      { op: "startStream", text: "old" },
      { op: "stopStream", ts: "101" },
    ]);
    expect(render.messageTs).toBe("101");
  });

  test("replace stops the stream but keeps the message identity", async () => {
    const { ops, calls } = makeOps();
    const render = new SlackProgressiveRender(ops, THREAD);

    await render.delta("Hello", true);
    await render.replace("Replaced text", false);

    expect(calls).toEqual([
      { op: "startStream", text: "Hello" },
      { op: "stopStream", ts: "101" },
      { op: "updateMessage", ts: "101", text: "Replaced text" },
    ]);
    expect(render.messageTs).toBe("101");
  });

  test("setWorking(false) during a stream stops it without an extra update", async () => {
    const { ops, calls } = makeOps();
    const render = new SlackProgressiveRender(ops, THREAD);

    await render.delta("Hello", true);
    await render.setWorking("Hello", false);

    expect(calls).toEqual([
      { op: "startStream", text: "Hello" },
      { op: "stopStream", ts: "101" },
    ]);
  });

  test("setWorking toggles the indicator on the block path", async () => {
    const { ops, calls } = makeOps();
    const render = new SlackProgressiveRender(ops, TOP_LEVEL);

    await render.delta("Hello", true);
    await render.setWorking("Hello", false);
    await render.setWorking("Hello", true);

    expect(calls.slice(1)).toEqual([
      { op: "updateMessage", ts: "101", text: "Hello" },
      { op: "updateMessage", ts: "101", text: `Hello${WORKING_INDICATOR}` },
    ]);
  });

  test("clearMessage forgets the message so the next render posts fresh", async () => {
    const { ops, calls } = makeOps();
    const render = new SlackProgressiveRender(ops, TOP_LEVEL);

    await render.delta("Hello", false);
    render.clearMessage();
    await render.delta("Again", false);

    expect(render.messageTs).toBe("102");
    expect(calls.map((call) => call.op)).toEqual(["postMessage", "postMessage"]);
  });
});
