import { beforeEach, describe, expect, it, vi } from "vitest";
import { JevNotConfiguredError, JevRequestError } from "../harness/jev.js";
import { createJevTool } from "../harness/tools/jev.js";

vi.mock("../harness/jev.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/jev.js")>();
  return { ...actual, evaluateWithJev: vi.fn() };
});

const { evaluateWithJev } = await import("../harness/jev.js");
const evaluateWithJevMock = vi.mocked(evaluateWithJev);

const booleanQ = { q: { type: "boolean" as const, instructions: "?" } };

function parse(result: { content: { type: string; text?: string }[] }) {
  const part = result.content[0];
  if (!part || part.type !== "text") throw new Error("expected text content");
  return JSON.parse(part.text!);
}

beforeEach(() => {
  evaluateWithJevMock.mockReset();
  evaluateWithJevMock.mockResolvedValue({
    answers: { q: { type: "boolean", probability: 0.92 } },
    usage: { inputTokens: 10, outputTokens: 1, cost: 0.0001 },
    model: "typesafe/jev-test",
  });
});

describe("jev tool", () => {
  it("sends text state and returns answers, model, and usage", async () => {
    const tool = createJevTool();
    const result = await tool.execute("c", {
      label: "spam",
      state: "BUY NOW",
      questions: { q: { type: "boolean", instructions: "Is this spam?" } },
    });

    expect(evaluateWithJevMock).toHaveBeenCalledWith(
      "BUY NOW",
      { q: { type: "boolean", instructions: "Is this spam?" } },
      expect.objectContaining({ caller: "jev_tool" }),
    );
    expect(parse(result)).toMatchObject({
      answers: { q: { probability: 0.92 } },
      model: "typesafe/jev-test",
      usage: { cost: 0.0001 },
    });
  });

  it("passes structured state, instructions, and criteria through untouched", async () => {
    const tool = createJevTool();
    const state = { message: "charged twice", order: { id: "A-1" } };
    await tool.execute("c", {
      label: "l",
      state,
      questions: {
        refund: {
          type: "boolean",
          instructions: { question: "Wants refund?", focus: "money back" },
          criteria: { true: "asks for money back", false: "anything else" },
        },
        dept: {
          type: "choice",
          instructions: "team?",
          criteria: { billing: { what: "charges", examples: ["charged twice"] }, orders: null },
        },
        sev: { type: "score", instructions: "severity", criteria: ["low", "mid", "high"] },
      },
    });

    expect(evaluateWithJevMock.mock.calls[0]?.[0]).toEqual(state);
    expect(evaluateWithJevMock.mock.calls[0]?.[1]).toEqual({
      refund: {
        type: "boolean",
        instructions: { question: "Wants refund?", focus: "money back" },
        criteria: { true: "asks for money back", false: "anything else" },
      },
      dept: {
        type: "choice",
        instructions: "team?",
        criteria: { billing: { what: "charges", examples: ["charged twice"] }, orders: null },
      },
      sev: { type: "score", instructions: "severity", criteria: ["low", "mid", "high"] },
    });
  });

  it("returns choice probabilities, confidence, and score legend", async () => {
    const tool = createJevTool();
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
        dept: { type: "choice", instructions: "?", criteria: { billing: null, orders: null } },
        sev: { type: "score", instructions: "?", criteria: ["low", "mid", "high"] },
      },
    });

    expect(parse(result).answers).toMatchObject({
      dept: { choice: "billing", probabilities: { billing: 0.9 }, confidence: 0.85 },
      sev: { score: 1.2, legend: { "1": "mid" }, confidence: 0.5 },
    });
  });

  it("rejects malformed criteria before calling jev", async () => {
    const tool = createJevTool();
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

  it("surfaces a missing API key as an actionable tool error", async () => {
    const tool = createJevTool();
    evaluateWithJevMock.mockRejectedValue(new JevNotConfiguredError());
    await expect(
      tool.execute("c", { label: "l", state: "x", questions: booleanQ }),
    ).rejects.toThrow("Judge the input yourself");
  });

  it("passes request errors through unchanged", async () => {
    const tool = createJevTool();
    evaluateWithJevMock.mockRejectedValue(new JevRequestError("rate limited", 429));
    await expect(
      tool.execute("c", { label: "l", state: "x", questions: booleanQ }),
    ).rejects.toThrow("rate limited");
  });
});
