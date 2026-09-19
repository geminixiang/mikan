/**
 * Jev (typesafe/jev) client, backed by `@geminixiang/jev`.
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
 * `@geminixiang/jev` owns the wire protocol, provider catalog, and auth
 * resolution for four backends (TypeSafe, OpenRouter, Vercel AI Gateway,
 * Cloudflare Workers AI); this module picks OpenRouter (the same key
 * pi-ai's `openrouter` chat provider reads) and adapts its typed
 * request/answer shapes to the caller-facing contract mikan's call sites
 * already depend on, so this file is the only one that needs to know a
 * dependency swap happened.
 */
import {
  createBuiltinJevModels,
  JevAPIError,
  JevAuthError,
  JevConfigError,
  JevConnectionError,
  JevResponseError,
  JevTimeoutError,
  type AnswerFor as GeminixiangAnswerFor,
  type Entry as GeminixiangEntry,
  type Question as GeminixiangQuestion,
} from "@geminixiang/jev";
import type { AuthContext } from "@earendil-works/pi-ai";
import { readEnv } from "../env-manifest.js";

/** The current public Jev model id on OpenRouter. */
export const JEV_MODEL_ID = "~typesafe/jev-latest";

/**
 * Any value Jev accepts as text-bearing structure: a string, a JSON object,
 * an array, or `null`. State, instructions, and criteria descriptions all
 * take this shape; Jev is trained to read the structure, so objects with
 * labelled keys are preferred over string templates.
 */
export type JevEntry = string | number | boolean | null | JevEntry[] | { [key: string]: JevEntry };

/** A shared caller-facing question shape; translated to `@geminixiang/jev`'s shape below. */
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

/** Thrown when no Jev backend has a usable credential. Callers fail closed on this. */
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

// ── @geminixiang/jev wiring ──────────────────────────────────────────────

/**
 * Routes env reads through `readEnv` so `MIKAN_OPENROUTER_API_KEY` resolves
 * the same as every other mikan-aliased credential, instead of the
 * package's default `process.env`-only context.
 */
const mikanAuthContext: AuthContext = {
  async env(name) {
    return readEnv(name);
  },
  async fileExists() {
    return false;
  },
};

let cachedModels: ReturnType<typeof createBuiltinJevModels> | undefined;

function models() {
  cachedModels ??= createBuiltinJevModels({ authContext: mikanAuthContext });
  return cachedModels;
}

function toGeminixiangQuestion(question: JevQuestion): GeminixiangQuestion {
  const instructions = question.instructions as GeminixiangEntry;
  if (question.type === "boolean") {
    // `@geminixiang/jev` leaves noul criteria optional; mikan has always sent
    // an explicit Yes/No default so the wire payload (and anything tuned
    // against it, e.g. the auto-reply gate) does not change under this swap.
    return {
      type: "noul",
      instructions,
      criteria: {
        true: (question.criteria?.true as GeminixiangEntry) ?? "Yes",
        false: (question.criteria?.false as GeminixiangEntry) ?? "No",
      },
    };
  }
  if (question.type === "choice") {
    return {
      type: "choice",
      instructions,
      criteria: question.criteria as Record<string, GeminixiangEntry>,
    };
  }
  const [first, second, ...rest] = question.criteria as GeminixiangEntry[];
  if (first === undefined || second === undefined) {
    throw new Error("score questions need at least two levels");
  }
  return { type: "score", instructions, criteria: [first, second, ...rest] };
}

function fromGeminixiangAnswer(
  answer: GeminixiangAnswerFor<GeminixiangQuestion>,
): JevAnswer<JevQuestion> {
  if (answer.type === "noul") {
    return { type: "boolean", probability: answer.noul };
  }
  if (answer.type === "choice") {
    return {
      type: "choice",
      choice: answer.choice,
      probabilities: answer.probabilities as Record<string, number>,
      confidence: answer.confidence,
    };
  }
  return {
    type: "score",
    score: answer.score,
    probabilities: answer.probabilities,
    legend: answer.legend as Record<string, string> | undefined,
    confidence: answer.confidence,
  };
}

/**
 * Evaluate one or more typed questions against a shared `state` using Jev,
 * reached through OpenRouter's decisions API by way of `@geminixiang/jev`.
 * Every question is scored independently against the same state in a
 * single request; batching questions here is cheap (they share the input)
 * and is preferred over separate calls per question.
 */
export async function evaluateWithJev<const QUESTIONS extends JevQuestions>(
  state: JevEntry,
  questions: QUESTIONS,
  options: EvaluateWithJevOptions = {},
): Promise<JevResult<QUESTIONS>> {
  const catalogModel = models().getModel("openrouter", "jev-latest");
  if (!catalogModel) throw new JevNotConfiguredError();
  // `options.model` is the wire model id callers already pass (e.g. from
  // JEV_MODEL_ID); override the catalog slug directly rather than adding a
  // second catalog entry per possible override.
  const model = options.model ? { ...catalogModel, slug: options.model } : catalogModel;

  const wireQuestions: Record<string, GeminixiangQuestion> = {};
  for (const [id, question] of Object.entries(questions)) {
    wireQuestions[id] = toGeminixiangQuestion(question);
  }

  let result;
  try {
    result = await models().evaluate(
      model,
      { state: state as GeminixiangEntry, questions: wireQuestions },
      {
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      },
    );
  } catch (error) {
    if (error instanceof JevAuthError || error instanceof JevConfigError) {
      throw new JevNotConfiguredError();
    }
    if (error instanceof JevAPIError) {
      throw new JevRequestError(error.message, error.status);
    }
    if (
      error instanceof JevResponseError ||
      error instanceof JevConnectionError ||
      error instanceof JevTimeoutError
    ) {
      throw new JevRequestError(error.message, 502);
    }
    throw error;
  }

  const answers = {} as { [ID in keyof QUESTIONS]: JevAnswer<QUESTIONS[ID]> };
  for (const id of Object.keys(questions)) {
    const answer = result.answers[id];
    if (!answer) throw new JevRequestError(`Jev response missing answer for "${id}"`, 502);
    (answers as Record<string, JevAnswer<JevQuestion>>)[id] = fromGeminixiangAnswer(answer);
  }

  return {
    answers,
    usage: {
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cost: result.usage.cost.total,
    },
    model: result.model,
  };
}
