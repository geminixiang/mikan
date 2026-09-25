import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const recordJevOutcomeMock = vi.hoisted(() => vi.fn());
vi.mock("../observability/index.js", () => ({ recordJevOutcome: recordJevOutcomeMock }));

import {
  JEV_MODEL_ID,
  JevNotConfiguredError,
  JevRequestError,
  evaluateWithJev,
} from "../harness/jev.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface JevRequestBody {
  model: string;
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

  test("throws JevNotConfiguredError when OPENROUTER_API_KEY is unset", async () => {
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
  });

  test("translates a boolean question to noul and back", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    fetchMock.mockResolvedValue(
      jsonResponse({
        model: "typesafe/jev-1.0",
        answers: { q: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 2, cost: 0.0001 },
      }),
    );

    const questions = { q: { type: "boolean" as const, instructions: "is it urgent?" } };
    const result = await evaluateWithJev("a support ticket", questions, { caller: "jev_tool" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.ai/api/alpha/decisions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
    const sent = requestBody(fetchMock, 0);
    expect(sent.model).toBe(JEV_MODEL_ID);
    expect(sent.questions.q).toEqual({
      type: "noul",
      instructions: "is it urgent?",
      criteria: { true: "Yes", false: "No" },
    });
    expect(result.answers.q).toEqual({ type: "boolean", probability: 0.9 });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, cost: 0.0001 });
    expect(recordJevOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: "jev_tool",
        status: "ok",
        inputTokens: 10,
        outputTokens: 2,
        costUsd: 0.0001,
      }),
    );
  });

  test("passes choice and score questions through and translates answers", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    fetchMock.mockResolvedValue(
      jsonResponse({
        model: "typesafe/jev-1.0",
        answers: {
          department: { type: "choice", choice: "billing", probabilities: { billing: 0.9 } },
          frustration: { type: "score", score: 1.2, probabilities: { "1": 0.8 } },
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
      probabilities: { billing: 0.9 },
    });
    expect(result.answers.frustration).toEqual({
      type: "score",
      score: 1.2,
      probabilities: { "1": 0.8 },
    });
  });

  test("allows overriding the model id", async () => {
    process.env.OPENROUTER_API_KEY = "test-key";
    fetchMock.mockResolvedValue(
      jsonResponse({ model: "typesafe/jev-preview", answers: { q: { type: "noul", noul: 0.1 } } }),
    );

    await evaluateWithJev(
      "state",
      { q: { type: "boolean", instructions: "is it?" } },
      { model: "~typesafe/jev-preview", caller: "jev_tool" },
    );

    expect(requestBody(fetchMock, 0).model).toBe("~typesafe/jev-preview");
  });

  test("throws JevRequestError on a non-ok response", async () => {
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

  test("reports an error outcome when the API key is missing, since a request was still attempted", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.MIKAN_OPENROUTER_API_KEY;
    await expect(
      evaluateWithJev(
        "state",
        { q: { type: "boolean", instructions: "is it?" } },
        { caller: "jev_tool" },
      ),
    ).rejects.toThrow(JevNotConfiguredError);
    expect(recordJevOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({ caller: "jev_tool", status: "error" }),
    );
  });
});
