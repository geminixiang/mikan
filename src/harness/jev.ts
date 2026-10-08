import type {
  AuthContext,
  ClassifierAnswer,
  ClassifierQuestion,
  JsonObject,
  Models,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { readEnv } from "../env-manifest.js";
import { isRecord } from "../unknown-values.js";
import { recordJevOutcome } from "../observability/index.js";
import type { JevCaller } from "../observability/types.js";
import type { MikanModels } from "./models.js";

const DEFAULT_JEV_PROVIDER = "openrouter";
const DEFAULT_JEV_MODEL = "~typesafe/jev-latest";
const JEV_TIMEOUT_MS = 30_000;
const JEV_MAX_RETRIES = 2;

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

type JevAnswer<QUESTION extends JevQuestion> = QUESTION extends { type: "choice" }
  ? {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  : QUESTION extends { type: "score" }
    ? { type: "score"; score: number; confidence: number }
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
  constructor(provider: string, model: string) {
    super(
      `Jev model ${provider}/${model} is not available: define it in models.json or set its provider's API key (OPENROUTER_API_KEY for the default ${DEFAULT_JEV_PROVIDER}/${DEFAULT_JEV_MODEL}).`,
    );
    this.name = "JevNotConfiguredError";
  }
}

export interface JevBinding {
  models: MikanModels;
  provider: string;
  model: string;
}

export class JevRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevRequestError";
  }
}

export interface EvaluateWithJevOptions {
  abortSignal?: AbortSignal;
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

let defaultModels: Models | undefined;
let binding: JevBinding | undefined;

export function configureJev(next: JevBinding | undefined): void {
  binding = next;
}

function jevModels(): { models: Models; provider: string; model: string } {
  if (binding)
    return { models: binding.models.models, provider: binding.provider, model: binding.model };
  defaultModels ??= builtinModels({ authContext: mikanAuthContext });
  return { models: defaultModels, provider: DEFAULT_JEV_PROVIDER, model: DEFAULT_JEV_MODEL };
}

function text(entry: JevEntry | undefined, fallback: string): string {
  if (entry === undefined || entry === null) return fallback;
  return typeof entry === "string" ? entry : JSON.stringify(entry);
}

function toState(state: JevEntry): JsonObject {
  if (typeof state === "string") return { text: state };
  if (isRecord(state)) return state;
  return { value: state };
}

function toClassifierQuestion(question: JevQuestion): ClassifierQuestion {
  const instructions = text(question.instructions, "");
  if (question.type === "boolean") {
    return {
      type: "bool",
      instructions,
      criteria: {
        true: text(question.criteria?.true, "Yes"),
        false: text(question.criteria?.false, "No"),
      },
    };
  }
  if (question.type === "choice") {
    return {
      type: "choice",
      instructions,
      criteria: Object.fromEntries(
        Object.entries(question.criteria).map(([id, value]) => [id, text(value, id)]),
      ),
    };
  }
  if (question.criteria.length < 2) throw new Error("score questions need at least two levels");
  return {
    type: "score",
    instructions,
    criteria: question.criteria.map((level) => text(level, "")),
  };
}

function fromClassifierAnswer(answer: ClassifierAnswer): JevAnswer<JevQuestion> {
  if (answer.type === "bool") return { type: "boolean", probability: answer.probability };
  return answer;
}

export async function evaluateWithJev<const QUESTIONS extends JevQuestions>(
  state: JevEntry,
  questions: QUESTIONS,
  options: EvaluateWithJevOptions,
): Promise<JevResult<QUESTIONS>> {
  const startedAt = Date.now();
  const fail = (error: Error): never => {
    recordJevOutcome({
      caller: options.caller,
      status: "error",
      errorType: error.name,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  };

  const jev = jevModels();
  const model = jev.models.getModelOfType("classifier", jev.provider, jev.model);
  if (!model || !(await jev.models.getAuth(model))) {
    return fail(new JevNotConfiguredError(jev.provider, jev.model));
  }

  const result = await jev.models.classify(
    model,
    {
      state: toState(state),
      questions: Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [id, toClassifierQuestion(question)]),
      ),
    },
    { signal: options.abortSignal, timeoutMs: JEV_TIMEOUT_MS, maxRetries: JEV_MAX_RETRIES },
  );
  if (result.stopReason !== "stop") {
    return fail(new JevRequestError(result.errorMessage ?? `Jev request ${result.stopReason}`));
  }

  recordJevOutcome({
    caller: options.caller,
    status: "ok",
    inputTokens: result.usage?.input,
    outputTokens: result.usage?.output,
    costUsd: result.usage?.cost.total,
    durationMs: Date.now() - startedAt,
  });

  const answers = {} as { [ID in keyof QUESTIONS]: JevAnswer<QUESTIONS[ID]> };
  for (const id of Object.keys(questions)) {
    const answer = result.answers[id];
    if (!answer) return fail(new JevRequestError(`Jev response missing answer for "${id}"`));
    (answers as Record<string, JevAnswer<JevQuestion>>)[id] = fromClassifierAnswer(answer);
  }

  return {
    answers,
    usage: {
      inputTokens: result.usage?.input,
      outputTokens: result.usage?.output,
      cost: result.usage?.cost.total,
    },
    model: result.model,
  };
}
