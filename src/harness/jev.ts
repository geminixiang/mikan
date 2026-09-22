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
import { recordJevOutcome, type JevCaller } from "../observability/index.js";

export const JEV_MODEL_ID = "~typesafe/jev-latest";

export type JevEntry = string | number | boolean | null | JevEntry[] | { [key: string]: JevEntry };

export type JevQuestion =
  | {
      type: "boolean";
      instructions: JevEntry;
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
      confidence?: number;
    }
  : QUESTION extends { type: "score" }
    ? {
        type: "score";
        score: number;
        probabilities?: Record<string, number>;
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
  model?: string;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
  caller: JevCaller;
}

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

export async function evaluateWithJev<const QUESTIONS extends JevQuestions>(
  state: JevEntry,
  questions: QUESTIONS,
  options: EvaluateWithJevOptions,
): Promise<JevResult<QUESTIONS>> {
  const catalogModel = models().getModel("openrouter", "jev-latest");
  if (!catalogModel) throw new JevNotConfiguredError();
  const model = options.model ? { ...catalogModel, slug: options.model } : catalogModel;

  const wireQuestions: Record<string, GeminixiangQuestion> = {};
  for (const [id, question] of Object.entries(questions)) {
    wireQuestions[id] = toGeminixiangQuestion(question);
  }

  const startedAt = Date.now();
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
    recordJevOutcome({
      caller: options.caller,
      status: "error",
      errorType: error instanceof Error ? error.name : "Error",
      durationMs: Date.now() - startedAt,
    });
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
  recordJevOutcome({
    caller: options.caller,
    status: "ok",
    inputTokens: result.usage.input,
    outputTokens: result.usage.output,
    costUsd: result.usage.cost.total,
    durationMs: Date.now() - startedAt,
  });

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
