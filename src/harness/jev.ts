/**
 * Jev (typesafe/jev) client, reached through OpenRouter's decisions API.
 *
 * Jev is a "System One" evaluation model: it scores a shared `state`
 * against typed questions (a yes/no probability, a multiple choice, or a
 * position on an ordered scale) and returns calibrated probabilities. It
 * does not generate text or tool calls, so it cannot be driven through
 * pi-ai's `Provider`/`Model`/`stream()` contract the way every model
 * `models.ts` catalogs is — that contract is chat/completion shaped
 * (system prompt + messages in, streamed text/tool-call events out), and
 * Jev's typed-decision shape does not fit it. Jev is therefore not a
 * selectable chat provider: callers import `evaluateWithJev` directly at
 * whatever call site wants a fast, cheap, type-safe decision (e.g.
 * classification, routing, guardrails), and interpret the returned
 * probabilities themselves.
 *
 * Requires `OPENROUTER_API_KEY` (see env-manifest.ts) — the same key
 * pi-ai's `openrouter` chat provider reads. `evaluateWithJev` calls
 * OpenRouter's `/api/alpha/decisions` REST endpoint directly; this is a
 * plain typed-decision API, not chat/completion, so it does not go
 * through pi-ai's provider machinery.
 */
import { readEnv } from "../env-manifest.js";

/** The current public Jev model id on OpenRouter. */
export const JEV_MODEL_ID = "~typesafe/jev-latest";

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/**
 * Any value Jev accepts as text-bearing structure: a string, a JSON object,
 * an array, or `null`. State, instructions, and criteria descriptions all
 * take this shape; Jev is trained to read the structure, so objects with
 * labelled keys are preferred over string templates.
 */
export type JevEntry = string | number | boolean | null | JevEntry[] | { [key: string]: JevEntry };

/** A shared caller-facing question shape; translated to OpenRouter's wire format below. */
export type JevQuestion =
  | {
      type: "boolean";
      instructions: JevEntry;
      /** Optional descriptions of the yes / no outcomes. */
      criteria?: { true?: JevEntry; false?: JevEntry };
    }
  | { type: "choice"; instructions: JevEntry; criteria: Record<string, JevEntry> }
  | { type: "score"; instructions: JevEntry; criteria: readonly JevEntry[] };

export type JevQuestions = Record<string, JevQuestion>;

export type JevAnswer<QUESTION extends JevQuestion> = QUESTION extends { type: "choice" }
  ? {
      type: "choice";
      choice: string;
      probabilities?: Record<string, number>;
      /** 0-1 statistic over `probabilities`; low means no option clearly fits. */
      confidence?: number;
    }
  : QUESTION extends { type: "score" }
    ? {
        type: "score";
        /** Expected level index; fractional between levels. */
        score: number;
        probabilities?: Record<string, number>;
        /** Level index -> criterion text, as echoed by Jev. */
        legend?: Record<string, string>;
        confidence?: number;
      }
    : { type: "boolean"; probability: number };

export interface JevResult<QUESTIONS extends JevQuestions> {
  readonly answers: { [ID in keyof QUESTIONS]: JevAnswer<QUESTIONS[ID]> };
  readonly usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    cost: number | undefined;
  };
  readonly model: string;
}

export class JevNotConfiguredError extends Error {
  constructor() {
    super(
      "Jev requires OPENROUTER_API_KEY (an OpenRouter API key). Set it in the environment before calling evaluateWithJev().",
    );
    this.name = "JevNotConfiguredError";
  }
}

export class JevRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "JevRequestError";
  }
}

export interface EvaluateWithJevOptions {
  /** Evaluation model id; defaults to the current public Jev model. */
  model?: string;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
}

// ── wire format (OpenRouter decisions API) ──────────────────────────────────

type OpenRouterQuestion =
  | {
      type: "noul";
      instructions: JevEntry;
      criteria: { true: JevEntry; false: JevEntry };
    }
  | { type: "choice"; instructions: JevEntry; criteria: Record<string, JevEntry> }
  | { type: "score"; instructions: JevEntry; criteria: readonly JevEntry[] };

interface OpenRouterAnswer {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
  legend?: Record<string, string>;
}

interface OpenRouterDecisionsResponse {
  model: string;
  answers: Record<string, OpenRouterAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
  error?: { message: string; code?: number };
}

function toOpenRouterQuestion(question: JevQuestion): OpenRouterQuestion {
  if (question.type === "boolean") {
    return {
      type: "noul",
      instructions: question.instructions,
      criteria: {
        true: question.criteria?.true ?? "Yes",
        false: question.criteria?.false ?? "No",
      },
    };
  }
  return question;
}

function fromOpenRouterAnswer(answer: OpenRouterAnswer): JevAnswer<JevQuestion> {
  if (answer.type === "noul") {
    return { type: "boolean", probability: answer.noul ?? 0 };
  }
  if (answer.type === "choice") {
    return {
      type: "choice",
      choice: answer.choice ?? "",
      probabilities: answer.probabilities,
      confidence: answer.confidence,
    };
  }
  return {
    type: "score",
    score: answer.score ?? 0,
    probabilities: answer.probabilities,
    legend: answer.legend,
    confidence: answer.confidence,
  };
}

/**
 * Evaluate one or more typed questions against a shared `state` using Jev,
 * reached through OpenRouter's decisions API. Every question is scored
 * independently against the same state in a single request; batching
 * questions here is cheap (they share the input) and is preferred over
 * separate calls per question.
 */
export async function evaluateWithJev<const QUESTIONS extends JevQuestions>(
  state: JevEntry,
  questions: QUESTIONS,
  options: EvaluateWithJevOptions = {},
): Promise<JevResult<QUESTIONS>> {
  const apiKey = readEnv("OPENROUTER_API_KEY");
  if (!apiKey) throw new JevNotConfiguredError();

  const wireQuestions: Record<string, OpenRouterQuestion> = {};
  for (const [id, question] of Object.entries(questions)) {
    wireQuestions[id] = toOpenRouterQuestion(question);
  }

  const response = await fetch(OPENROUTER_DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify({
      model: options.model ?? JEV_MODEL_ID,
      state,
      questions: wireQuestions,
    }),
    signal: options.abortSignal,
  });

  const body = (await response.json()) as OpenRouterDecisionsResponse;
  if (!response.ok || body.error) {
    throw new JevRequestError(
      body.error?.message ?? `Jev request failed with status ${response.status}`,
      body.error?.code ?? response.status,
    );
  }

  const answers = {} as { [ID in keyof QUESTIONS]: JevAnswer<QUESTIONS[ID]> };
  for (const id of Object.keys(questions)) {
    const answer = body.answers[id];
    if (!answer) throw new JevRequestError(`Jev response missing answer for "${id}"`, 502);
    (answers as Record<string, JevAnswer<JevQuestion>>)[id] = fromOpenRouterAnswer(answer);
  }

  return {
    answers,
    usage: {
      inputTokens: body.usage?.input_tokens,
      outputTokens: body.usage?.output_tokens,
      cost: body.usage?.cost,
    },
    model: body.model,
  };
}
