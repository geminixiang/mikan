import { beforeEach, describe, expect, it, vi } from "vitest";
import { JevNotConfiguredError, JevRequestError, type JevEntry } from "../harness/jev.js";
import {
  createJevTool,
  JEV_TOOL_MAX_ITEMS,
  JEV_TOOL_MAX_STATE_CHARS,
} from "../harness/tools/jev.js";

vi.mock("../harness/jev.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/jev.js")>();
  return { ...actual, evaluateWithJev: vi.fn() };
});

const { evaluateWithJev } = await import("../harness/jev.js");
const evaluateWithJevMock = vi.mocked(evaluateWithJev);

const booleanQ = { q: { type: "boolean" as const, instructions: "?" } };

function setup(files: Record<string, string> = {}) {
  const { tool, setStateReader } = createJevTool();
  const readState = vi.fn(async (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  });
  setStateReader(readState);
  return { tool, readState };
}

function parse(result: { content: { type: string; text?: string }[] }) {
  const part = result.content[0];
  if (!part || part.type !== "text") throw new Error("expected text content");
  return JSON.parse(part.text!);
}

function booleanResult(probability: number) {
  return {
    answers: { q: { type: "boolean" as const, probability } },
    usage: { inputTokens: 10, outputTokens: 1, cost: 0.0001 },
    model: "typesafe/jev-test",
  };
}

beforeEach(() => {
  evaluateWithJevMock.mockReset();
  evaluateWithJevMock.mockResolvedValue(booleanResult(0.92));
});

describe("jev tool: single state", () => {
  it("sends inline text and returns answers, model, and cost", async () => {
    const { tool } = setup();
    const result = await tool.execute("c", {
      label: "spam",
      state: "BUY NOW",
      questions: { q: { type: "boolean", instructions: "Is this spam?" } },
    });

    expect(evaluateWithJevMock).toHaveBeenCalledWith(
      "BUY NOW",
      { q: { type: "boolean", instructions: "Is this spam?" } },
      expect.objectContaining({}),
    );
    expect(parse(result)).toMatchObject({
      answers: { q: { probability: 0.92 } },
      model: "typesafe/jev-test",
      cost: 0.0001,
    });
  });

  it("passes structured state and instructions through untouched", async () => {
    const { tool } = setup();
    const state = { message: "charged twice", order: { id: "A-1" } };
    const instructions = { question: "Wants refund?", focus: "money back" };
    await tool.execute("c", {
      label: "l",
      state,
      questions: { q: { type: "boolean", instructions, criteria: { true: "asks", false: "no" } } },
    });

    expect(evaluateWithJevMock.mock.calls[0]?.[0]).toEqual(state);
    expect(evaluateWithJevMock.mock.calls[0]?.[1]).toEqual({
      q: { type: "boolean", instructions, criteria: { true: "asks", false: "no" } },
    });
  });

  it("reads statePath through the bound reader instead of the model", async () => {
    const { tool, readState } = setup({ "feedback.txt": "contents" });
    await tool.execute("c", { label: "l", statePath: "feedback.txt", questions: booleanQ });

    expect(readState).toHaveBeenCalledWith("feedback.txt");
    expect(evaluateWithJevMock.mock.calls[0]?.[0]).toBe("contents");
  });

  it("returns choice probabilities, confidence, and score legend", async () => {
    const { tool } = setup();
    evaluateWithJevMock.mockResolvedValue({
      answers: {
        dept: {
          type: "choice",
          choice: "billing",
          probabilities: { billing: 0.9, orders: 0.1 },
          confidence: 0.85,
        },
        sev: {
          type: "score",
          score: 1.2,
          probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
          legend: { "0": "low", "1": "mid", "2": "high" },
          confidence: 0.5,
        },
      },
      usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      model: "typesafe/jev-test",
    });

    const result = await tool.execute("c", {
      label: "l",
      state: "x",
      questions: {
        dept: {
          type: "choice",
          instructions: "team?",
          criteria: { billing: { what: "charges" }, orders: null },
        },
        sev: { type: "score", instructions: "severity", criteria: ["low", "mid", "high"] },
      },
    });

    expect(evaluateWithJevMock.mock.calls[0]?.[1]).toEqual({
      dept: {
        type: "choice",
        instructions: "team?",
        criteria: { billing: { what: "charges" }, orders: null },
      },
      sev: { type: "score", instructions: "severity", criteria: ["low", "mid", "high"] },
    });
    expect(parse(result).answers).toMatchObject({
      dept: { choice: "billing", confidence: 0.85 },
      sev: { score: 1.2, legend: { "1": "mid" } },
    });
  });
});

describe("jev tool: validation", () => {
  it("rejects malformed criteria before calling jev", async () => {
    const { tool } = setup();
    await expect(
      tool.execute("c", {
        label: "l",
        state: "x",
        questions: { q: { type: "choice", instructions: "?" } },
      }),
    ).rejects.toThrow("at least two options");
    await expect(
      tool.execute("c", {
        label: "l",
        state: "x",
        questions: { q: { type: "score", instructions: "?", criteria: ["only"] } },
      }),
    ).rejects.toThrow("at least two levels");
    await expect(
      tool.execute("c", {
        label: "l",
        state: "x",
        questions: { q: { type: "boolean", instructions: "?", criteria: ["nope"] } },
      }),
    ).rejects.toThrow('{"true": …, "false": …}');
    expect(evaluateWithJevMock).not.toHaveBeenCalled();
  });

  it("rejects choice options that list item numbers (pre-judged answers)", async () => {
    const { tool } = setup();
    await expect(
      tool.execute("c", {
        label: "l",
        state: "x",
        questions: {
          q: { type: "choice", instructions: "?", criteria: { "2, 5,7": "these", none: "none" } },
        },
      }),
    ).rejects.toThrow("use split");
    expect(evaluateWithJevMock).not.toHaveBeenCalled();
  });

  it("requires exactly one of state and statePath", async () => {
    const { tool } = setup();
    await expect(tool.execute("c", { label: "l", questions: booleanQ })).rejects.toThrow(
      "exactly one of state or statePath",
    );
    await expect(
      tool.execute("c", { label: "l", state: "a", statePath: "b", questions: booleanQ }),
    ).rejects.toThrow("exactly one of state or statePath");
    expect(evaluateWithJevMock).not.toHaveBeenCalled();
  });

  it("refuses oversized state with a split hint", async () => {
    const { tool } = setup();
    await expect(
      tool.execute("c", {
        label: "l",
        state: "x".repeat(JEV_TOOL_MAX_STATE_CHARS + 1),
        questions: booleanQ,
      }),
    ).rejects.toThrow("Use split");
    expect(evaluateWithJevMock).not.toHaveBeenCalled();
  });

  it("surfaces a missing API key as an actionable tool error", async () => {
    const { tool } = setup();
    evaluateWithJevMock.mockRejectedValue(new JevNotConfiguredError());
    await expect(
      tool.execute("c", { label: "l", state: "x", questions: booleanQ }),
    ).rejects.toThrow("Judge the input yourself");
  });

  it("passes request errors through unchanged", async () => {
    const { tool } = setup();
    evaluateWithJevMock.mockRejectedValue(new JevRequestError("rate limited", 429));
    await expect(
      tool.execute("c", { label: "l", state: "x", questions: booleanQ }),
    ).rejects.toThrow("rate limited");
  });

  it("is unavailable until a state reader is bound", async () => {
    const { tool } = createJevTool();
    await expect(
      tool.execute("c", { label: "l", state: "x", questions: booleanQ }),
    ).rejects.toThrow("not available");
  });
});

describe("jev tool: split", () => {
  it("judges each non-empty line separately and summarizes", async () => {
    const { tool } = setup({ "f.txt": "broken\n\nthanks\nrefund?\n" });
    evaluateWithJevMock.mockImplementation(async (state) =>
      booleanResult(state === "thanks" ? 0.05 : 0.9),
    );

    const result = parse(
      await tool.execute("c", {
        label: "l",
        statePath: "f.txt",
        split: "line",
        questions: booleanQ,
      }),
    );

    expect(evaluateWithJevMock).toHaveBeenCalledTimes(3);
    expect(result.count).toBe(3);
    expect(result.items).toEqual([
      { index: 1, preview: "broken", answers: { q: 0.9 } },
      { index: 2, preview: "thanks", answers: { q: 0.05 } },
      { index: 3, preview: "refund?", answers: { q: 0.9 } },
    ]);
    expect(result.summary.q).toEqual({ above_0_5: 2, between_0_3_and_0_7: 0 });
    expect(result.cost).toBeCloseTo(0.0003);
  });

  it("splits paragraphs and json arrays, wrapping each item with shared context", async () => {
    const { tool } = setup();
    await tool.execute("c", {
      label: "l",
      state: "para one\nstill one\n\npara two",
      split: "paragraph",
      context: { policy: "be nice" },
      questions: booleanQ,
    });
    expect(evaluateWithJevMock.mock.calls.map((call) => call[0])).toEqual([
      { context: { policy: "be nice" }, item: "para one\nstill one" },
      { context: { policy: "be nice" }, item: "para two" },
    ]);

    evaluateWithJevMock.mockClear();
    await tool.execute("c", {
      label: "l",
      state: [{ id: 1 }, { id: 2 }] as JevEntry,
      split: "json",
      questions: booleanQ,
    });
    expect(evaluateWithJevMock.mock.calls.map((call) => call[0])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("parses a json array from a file for split=json", async () => {
    const { tool } = setup({ "rows.json": JSON.stringify(["a", "b"]) });
    const result = parse(
      await tool.execute("c", {
        label: "l",
        statePath: "rows.json",
        split: "json",
        questions: booleanQ,
      }),
    );
    expect(result.count).toBe(2);
    expect(evaluateWithJevMock.mock.calls.map((call) => call[0])).toEqual(["a", "b"]);
  });

  it("compacts choice and score answers per item and counts choices", async () => {
    const { tool } = setup();
    evaluateWithJevMock.mockImplementation(async (state) => ({
      answers: {
        dept: {
          type: "choice" as const,
          choice: state === "a" ? "billing" : "orders",
          probabilities: { billing: 0.7, orders: 0.3 },
          confidence: 0.6,
        },
        sev: { type: "score" as const, score: 1, probabilities: {}, confidence: 0.4 },
      },
      usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
      model: "typesafe/jev-test",
    }));

    const result = parse(
      await tool.execute("c", {
        label: "l",
        state: "a\nb\nc",
        split: "line",
        questions: {
          dept: { type: "choice", instructions: "?", criteria: { billing: "b", orders: "o" } },
          sev: { type: "score", instructions: "?", criteria: ["low", "high"] },
        },
      }),
    );

    expect(result.items[0].answers).toEqual({
      dept: { choice: "billing", confidence: 0.6 },
      sev: { score: 1, confidence: 0.4 },
    });
    expect(result.summary).toEqual({
      dept: { counts: { billing: 1, orders: 2 } },
      sev: { mean: 1 },
    });
  });

  it("rejects json split on non-array input and line split on objects", async () => {
    const { tool } = setup();
    await expect(
      tool.execute("c", { label: "l", state: "not json", split: "json", questions: booleanQ }),
    ).rejects.toThrow("not valid JSON");
    await expect(
      tool.execute("c", { label: "l", state: { a: 1 }, split: "json", questions: booleanQ }),
    ).rejects.toThrow("JSON array at the top level");
    await expect(
      tool.execute("c", { label: "l", state: { a: 1 }, split: "line", questions: booleanQ }),
    ).rejects.toThrow("needs text");
    expect(evaluateWithJevMock).not.toHaveBeenCalled();
  });

  it("caps the number of items", async () => {
    const { tool } = setup();
    const state = Array.from({ length: JEV_TOOL_MAX_ITEMS + 1 }, (_, i) => `row ${i}`).join("\n");
    await expect(
      tool.execute("c", { label: "l", state, split: "line", questions: booleanQ }),
    ).rejects.toThrow(`limit is ${JEV_TOOL_MAX_ITEMS}`);
    expect(evaluateWithJevMock).not.toHaveBeenCalled();
  });
});
