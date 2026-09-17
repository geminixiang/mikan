import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const evaluateMock = vi.fn();

vi.mock("ai", () => ({
  experimental_evaluate: (...args: unknown[]) => evaluateMock(...args),
}));

const { JEV_MODEL_ID, JevNotConfiguredError, evaluateWithJev } = await import("../harness/jev.js");

describe("evaluateWithJev", () => {
  const originalKey = process.env.AI_GATEWAY_API_KEY;

  beforeEach(() => {
    evaluateMock.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = originalKey;
  });

  test("throws JevNotConfiguredError when AI_GATEWAY_API_KEY is unset", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    await expect(
      evaluateWithJev("state", { q: { type: "boolean", instructions: "is it?" } }),
    ).rejects.toThrow(JevNotConfiguredError);
    expect(evaluateMock).not.toHaveBeenCalled();
  });

  test("defaults to the Jev model id and forwards state/questions", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    evaluateMock.mockResolvedValue({ answers: { q: { type: "boolean", probability: 0.9 } } });

    const questions = { q: { type: "boolean" as const, instructions: "is it urgent?" } };
    const result = await evaluateWithJev("a support ticket", questions);

    expect(evaluateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: JEV_MODEL_ID,
        state: "a support ticket",
        questions,
      }),
    );
    expect(result).toEqual({ answers: { q: { type: "boolean", probability: 0.9 } } });
  });

  test("allows overriding the model id and passes through call options", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    evaluateMock.mockResolvedValue({ answers: {} });

    const abortController = new AbortController();
    await evaluateWithJev(
      "state",
      { q: { type: "score" as const, instructions: "rate it", criteria: ["low", "high"] } },
      { model: "typesafe-ai/jev-preview", maxRetries: 1, abortSignal: abortController.signal },
    );

    expect(evaluateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "typesafe-ai/jev-preview",
        maxRetries: 1,
        abortSignal: abortController.signal,
      }),
    );
  });
});
