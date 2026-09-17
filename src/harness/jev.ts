/**
 * Jev (typesafe-ai/jev) client, reached through Vercel AI Gateway.
 *
 * Jev is a "System One" evaluation model: it scores a shared `state`
 * against typed questions (a boolean probability, a multiple choice, or a
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
 * Requires `AI_GATEWAY_API_KEY` (see env-manifest.ts); `evaluateWithJev`
 * resolves the model id through the AI SDK's default gateway provider, the
 * same path pi-ai's built-in `vercel-ai-gateway` chat provider uses for
 * ordinary models.
 */
import {
  experimental_evaluate as evaluate,
  type Experimental_EvaluationQuestion as EvaluationQuestion,
  type Experimental_EvaluationResult as EvaluationResult,
} from "ai";
import { readStandardEnv } from "../env-manifest.js";

/** The current public Jev model id on Vercel AI Gateway. */
export const JEV_MODEL_ID = "typesafe-ai/jev";

export type JevQuestions = Record<string, EvaluationQuestion>;
export type JevResult<QUESTIONS extends JevQuestions> = EvaluationResult<QUESTIONS>;

/** The shared input Jev evaluates every question against. */
export type JevState = Parameters<typeof evaluate>[0]["state"];

export class JevNotConfiguredError extends Error {
  constructor() {
    super(
      "Jev requires AI_GATEWAY_API_KEY (a Vercel AI Gateway API key). Set it in the environment before calling evaluateWithJev().",
    );
    this.name = "JevNotConfiguredError";
  }
}

export interface EvaluateWithJevOptions {
  /** Evaluation model id; defaults to the current public Jev model. */
  model?: string;
  /** Maximum retries for transient provider failures. Defaults to the AI SDK's own default. */
  maxRetries?: number;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Evaluate one or more typed questions against a shared `state` using Jev.
 * Every question is scored independently against the same state in a
 * single request; batching questions here is cheap (they share the input)
 * and is preferred over separate calls per question.
 */
export async function evaluateWithJev<const QUESTIONS extends JevQuestions>(
  state: JevState,
  questions: QUESTIONS,
  options: EvaluateWithJevOptions = {},
): Promise<JevResult<QUESTIONS>> {
  if (!readStandardEnv("AI_GATEWAY_API_KEY")) throw new JevNotConfiguredError();

  return evaluate({
    model: options.model ?? JEV_MODEL_ID,
    state,
    questions,
    maxRetries: options.maxRetries,
    abortSignal: options.abortSignal,
    headers: options.headers,
  });
}
