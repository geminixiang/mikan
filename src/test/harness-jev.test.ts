import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const recordJevOutcomeMock = vi.hoisted(() => vi.fn());
vi.mock("../observability/index.js", () => ({ recordJevOutcome: recordJevOutcomeMock }));

import { JevNotConfiguredError, JevRequestError, evaluateWithJev } from "../harness/jev.js";

const SYSTEM_ONE_URL = "https://openrouter.ai/api/v1/systemone";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface JevRequestBody {
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
}

function requestBody(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  index: number,
): JevRequestBody {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") throw new Error(`fetch call ${index} has no string body`);
  return JSON.parse(body);
}

describe("evaluateWithJev", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = global.fetch;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    recordJevOutcomeMock.mockReset();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    global.fetch = originalFetch;
  });

  test("throws JevNotConfiguredError without a request when OPENROUTER_API_KEY is unset", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.MIKAN_OPENROUTER_API_KEY;
    await expect(
      evaluateWithJev(
        "state",
        { q: { type: "boolean", instructions: "is it?" } },
        { caller: "jev_tool" },
      ),
    ).rejects.toThrow(JevNotConfiguredError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordJevOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ caller: "jev_tool", status: "error" }),
    );
  });

  test("asks Jev on OpenRouter through pi-ai's System One classifier", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    fetchMock.mockResolvedValue(
      jsonResponse({
        model: "typesafe/jev-1.13",
        answers: { q: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 1000, output_tokens: 0 },
      }),
    );

    const result = await evaluateWithJev(
      "a support ticket",
      { q: { type: "boolean", instructions: "is it urgent?" } },
      { caller: "jev_tool" },
    );

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(SYSTEM_ONE_URL);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer test-key" }),
      }),
    );
    expect(requestBody(fetchMock, 0)).toEqual({
      model: "~typesafe/jev-latest",
      state: { text: "a support ticket" },
      questions: {
        q: {
          type: "noul",
          instructions: "is it urgent?",
          criteria: { true: "Yes", false: "No" },
        },
      },
    });
    expect(result.answers.q).toEqual({ type: "boolean", probability: 0.9 });
    expect(result.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 0,
      cost: expect.closeTo(0.000042, 12),
    });
    expect(recordJevOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: "jev_tool",
        status: "ok",
        inputTokens: 1000,
        outputTokens: 0,
        costUsd: expect.closeTo(0.000042, 12),
      }),
    );
  });

  test("sends an object state as is and JSON criteria as text", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    fetchMock.mockResolvedValue(jsonResponse({ answers: { q: { type: "noul", noul: 0.2 } } }));

    await evaluateWithJev(
      { goal: "find the button", page: "..." },
      {
        q: {
          type: "boolean",
          instructions: { ask: "is it visible?" },
          criteria: { true: { means: "shown" }, false: "hidden" },
        },
      },
      { caller: "jev_browser" },
    );

    expect(requestBody(fetchMock, 0)).toMatchObject({
      state: { goal: "find the button", page: "..." },
      questions: {
        q: {
          instructions: '{"ask":"is it visible?"}',
          criteria: { true: '{"means":"shown"}', false: "hidden" },
        },
      },
    });
  });

  test("returns choice and score answers with their confidence", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    fetchMock.mockResolvedValue(
      jsonResponse({
        answers: {
          department: {
            type: "choice",
            choice: "billing",
            probabilities: { billing: 0.9, technical: 0.1 },
            confidence: 0.8,
          },
          frustration: { type: "score", score: 1.2, confidence: 0.7 },
        },
      }),
    );

    const result = await evaluateWithJev(
      "state",
      {
        department: {
          type: "choice",
          instructions: "which team?",
          criteria: { billing: "Payments", technical: "Bugs" },
        },
        frustration: {
          type: "score",
          instructions: "rate it",
          criteria: ["Calm", "Frustrated", "Very angry"],
        },
      },
      { caller: "jev_tool" },
    );

    expect(result.answers.department).toEqual({
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.8,
    });
    expect(result.answers.frustration).toEqual({ type: "score", score: 1.2, confidence: 0.7 });
  });

  test("throws JevRequestError on a non-ok response and records the failure", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: "Missing Authentication header", code: 401 } }, 401),
    );

    await expect(
      evaluateWithJev(
        "state",
        { q: { type: "boolean", instructions: "is it?" } },
        { caller: "jev_tool" },
      ),
    ).rejects.toThrow(JevRequestError);
    expect(recordJevOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ caller: "jev_tool", status: "error" }),
    );
  });
});
