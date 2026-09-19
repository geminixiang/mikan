import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";
import {
  evaluateWithJev,
  JevNotConfiguredError,
  type JevAnswer,
  type JevEntry,
  type JevQuestion,
  type JevQuestions,
} from "../jev.js";
import { defineHostFnTool } from "./host-fn-tool.js";

/** Largest single state (inline or one split item) sent to Jev. */
export const JEV_TOOL_MAX_STATE_CHARS = 200_000;
/** Largest `statePath` file the tool will read. */
const JEV_TOOL_MAX_FILE_CHARS = 2_000_000;
/** Most items one `split` call fans out to. */
export const JEV_TOOL_MAX_ITEMS = 500;
/** Concurrent Jev requests while fanning out over items. */
const ITEM_CONCURRENCY = 8;
/** Characters of each item echoed back so the model can cite it without rereading. */
const ITEM_PREVIEW_CHARS = 80;

// Jev accepts arbitrary JSON in state, instructions, and criteria descriptions;
// `Type.Any` keeps that open while the object root stays provider-safe.
const entrySchema = Type.Any({
  description: "Text, or a JSON object/array of text. Jev reads structure, so labelled keys help.",
});

const questionSchema = Type.Object({
  type: Type.Union([Type.Literal("boolean"), Type.Literal("choice"), Type.Literal("score")], {
    description:
      "boolean: probability 0-1 that the instructions hold. choice: one option wins, with per-option probabilities and confidence. score: position on an ordered rubric (lowest first), fractional between levels.",
  }),
  instructions: entrySchema,
  criteria: Type.Optional(
    Type.Any({
      description:
        'choice: object {optionId: description|null}. score: array of level descriptions, lowest first. boolean (optional): {"true": description, "false": description}. Descriptions may be strings or JSON (e.g. {what, not_for, examples}).',
    }),
  ),
});

const jevSchema = Type.Object({
  label: Type.String({ description: "Brief description of the judgment (shown to user)" }),
  state: Type.Optional(
    Type.Any({
      description:
        "What to judge: text or a JSON object/array (prefer an object with labelled keys). Use this or statePath, not both.",
    }),
  ),
  statePath: Type.Optional(
    Type.String({
      description:
        "Workspace file to judge. Its contents go straight to Jev and never enter your context. Use this or state, not both.",
    }),
  ),
  split: Type.Optional(
    Type.Union([Type.Literal("line"), Type.Literal("paragraph"), Type.Literal("json")], {
      description:
        "Fan out: judge each item separately with the same questions and return one answer set per item. line = non-empty lines; paragraph = blank-line separated blocks; json = elements of a JSON array (state must be an array or the file must contain one). Use this whenever the question is about each item rather than the whole.",
    }),
  ),
  context: Type.Optional(
    Type.Any({
      description:
        "With split: shared facts every item is judged against (policy text, taxonomy, the user's request). Each item is sent as {context, item}.",
    }),
  ),
  questions: Type.Record(Type.String(), questionSchema, {
    description: "Questions keyed by id; all are answered against the same state in one request.",
    minProperties: 1,
  }),
});

type JevToolArgs = Static<typeof jevSchema>;
type QuestionArg = Static<typeof questionSchema>;
type SplitMode = NonNullable<JevToolArgs["split"]>;

/** Reads a workspace-relative file for `statePath`; bound per run. */
export type JevStateReader = (path: string) => Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJevQuestion(id: string, question: QuestionArg): JevQuestion {
  const instructions = question.instructions as JevEntry;
  if (question.type === "boolean") {
    if (question.criteria === undefined) return { type: "boolean", instructions };
    if (!isRecord(question.criteria)) {
      throw new Error(`Question "${id}" (boolean) criteria must be {"true": …, "false": …}`);
    }
    return {
      type: "boolean",
      instructions,
      criteria: question.criteria as { true?: JevEntry; false?: JevEntry },
    };
  }
  if (question.type === "choice") {
    if (!isRecord(question.criteria) || Object.keys(question.criteria).length < 2) {
      throw new Error(
        `Question "${id}" (choice) criteria must be an object with at least two options`,
      );
    }
    // An option id that is a list of indexes means the model already judged
    // the items itself and is asking Jev to rubber-stamp its answer.
    const indexList = Object.keys(question.criteria).find((key) => /^\d+(\s*,\s*\d+)+$/.test(key));
    if (indexList) {
      throw new Error(
        `Question "${id}" (choice) has an option "${indexList}" that lists item numbers. Do not pre-judge items; use split so Jev judges each item independently.`,
      );
    }
    return {
      type: "choice",
      instructions,
      criteria: question.criteria as Record<string, JevEntry>,
    };
  }
  if (!Array.isArray(question.criteria) || question.criteria.length < 2) {
    throw new Error(
      `Question "${id}" (score) criteria must be an array of at least two levels, lowest first`,
    );
  }
  return { type: "score", instructions, criteria: question.criteria as JevEntry[] };
}

function assertStateSize(state: JevEntry, what: string): void {
  const size = typeof state === "string" ? state.length : JSON.stringify(state).length;
  if (size > JEV_TOOL_MAX_STATE_CHARS) {
    throw new Error(
      `${what} is ${size} characters; limit is ${JEV_TOOL_MAX_STATE_CHARS}. Use split, or divide the input and judge the parts separately.`,
    );
  }
}

async function loadState(args: JevToolArgs, readState: JevStateReader): Promise<JevEntry> {
  const hasState = args.state !== undefined;
  const hasPath = typeof args.statePath === "string";
  if (hasState === hasPath) {
    throw new Error("Provide exactly one of state or statePath");
  }
  if (hasState) return args.state as JevEntry;

  const text = await readState(args.statePath!);
  if (text.length > JEV_TOOL_MAX_FILE_CHARS) {
    throw new Error(
      `File is ${text.length} characters; limit is ${JEV_TOOL_MAX_FILE_CHARS}. Split it into smaller files first.`,
    );
  }
  return text;
}

function splitItems(state: JevEntry, mode: SplitMode): JevEntry[] {
  if (mode === "json") {
    let value = state;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as JevEntry;
      } catch {
        throw new Error("split=json needs a JSON array; the input is not valid JSON");
      }
    }
    if (!Array.isArray(value)) throw new Error("split=json needs a JSON array at the top level");
    return value;
  }
  if (typeof state !== "string") {
    throw new Error(`split=${mode} needs text; pass a string state or use split=json`);
  }
  const parts = mode === "line" ? state.split(/\r?\n/) : state.split(/\r?\n\s*\r?\n/);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function previewOf(item: JevEntry): string {
  const text = typeof item === "string" ? item : JSON.stringify(item);
  return text.length > ITEM_PREVIEW_CHARS ? `${text.slice(0, ITEM_PREVIEW_CHARS)}…` : text;
}

/** Trim an answer to what the model needs when the result is one row of many. */
function compactAnswer(answer: JevAnswer<JevQuestion>): unknown {
  if (answer.type === "boolean") return answer.probability;
  if (answer.type === "choice") {
    return { choice: answer.choice, confidence: answer.confidence };
  }
  return { score: answer.score, confidence: answer.confidence };
}

async function evaluate(state: JevEntry, questions: JevQuestions, signal?: AbortSignal) {
  try {
    return await evaluateWithJev(state, questions, { abortSignal: signal });
  } catch (error) {
    if (error instanceof JevNotConfiguredError) {
      throw new Error(
        "Jev is not configured (OPENROUTER_API_KEY missing). Judge the input yourself.",
        { cause: error },
      );
    }
    throw error;
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function summarize(
  questions: JevQuestions,
  rows: { answers: Record<string, JevAnswer<JevQuestion>> }[],
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answers = rows.map((row) => row.answers[id]!);
    if (question.type === "boolean") {
      const probabilities = answers.map((answer) =>
        answer.type === "boolean" ? answer.probability : 0,
      );
      summary[id] = {
        above_0_5: probabilities.filter((p) => p >= 0.5).length,
        between_0_3_and_0_7: probabilities.filter((p) => p > 0.3 && p < 0.7).length,
      };
    } else if (question.type === "choice") {
      const counts: Record<string, number> = {};
      for (const answer of answers) {
        if (answer.type !== "choice") continue;
        counts[answer.choice] = (counts[answer.choice] ?? 0) + 1;
      }
      summary[id] = { counts };
    } else {
      const scores = answers.map((answer) => (answer.type === "score" ? answer.score : 0));
      const mean = scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1);
      summary[id] = { mean: Number(mean.toFixed(2)) };
    }
  }
  return summary;
}

async function runSingle(state: JevEntry, questions: JevQuestions, signal?: AbortSignal) {
  assertStateSize(state, "State");
  const result = await evaluate(state, questions, signal);
  return { answers: result.answers, model: result.model, cost: result.usage.cost };
}

async function runSplit(
  state: JevEntry,
  mode: SplitMode,
  context: JevEntry | undefined,
  questions: JevQuestions,
  signal?: AbortSignal,
) {
  const items = splitItems(state, mode);
  if (items.length === 0) throw new Error("split produced no items");
  if (items.length > JEV_TOOL_MAX_ITEMS) {
    throw new Error(
      `split produced ${items.length} items; limit is ${JEV_TOOL_MAX_ITEMS}. Divide the input and judge the parts separately.`,
    );
  }
  for (const [index, item] of items.entries()) assertStateSize(item, `Item ${index + 1}`);

  let cost = 0;
  let model = "";
  const rows = await mapConcurrent(items, ITEM_CONCURRENCY, async (item, index) => {
    if (signal?.aborted) throw new Error("Operation aborted");
    const itemState: JevEntry = context === undefined ? item : { context, item };
    const result = await evaluate(itemState, questions, signal);
    cost += result.usage.cost ?? 0;
    model = result.model;
    return { index: index + 1, preview: previewOf(item), answers: result.answers };
  });

  return {
    count: rows.length,
    summary: summarize(questions, rows),
    items: rows.map((row) => ({
      index: row.index,
      preview: row.preview,
      answers: Object.fromEntries(
        Object.entries(row.answers).map(([id, answer]) => [id, compactAnswer(answer)]),
      ),
    })),
    model,
    cost,
  };
}

/**
 * The `jev` tool exposes calibrated typed judgments (boolean / choice / score)
 * to the model as an ordinary tool call, covering the full Jev surface:
 * structured JSON state, instructions, and criteria; per-option
 * probabilities and confidence; and a `split` fan-out that judges each item
 * of a file or array independently. Its value over the model judging in its
 * own context is that the state never has to enter that context. Unlike the
 * harness-internal decision points, a missing OPENROUTER_API_KEY surfaces as
 * a tool error so the model knows to judge for itself instead of silently
 * falling back.
 */
export function createJevTool(): {
  tool: AgentTool<typeof jevSchema>;
  setStateReader: (fn: JevStateReader | null) => void;
} {
  const { tool, setFn } = defineHostFnTool<JevStateReader, typeof jevSchema>({
    name: "jev",
    description: [
      "Ask Jev, a fast calibrated judgment model, typed questions about text, JSON, or a workspace file. It never generates text; it returns probabilities.",
      "Question types: boolean (probability 0-1), choice (one option from a set, with probabilities and confidence), score (position on an ordered rubric).",
      "Use it to classify, filter, rank, extract, or verify — especially inputs too large or too many to read yourself, or whenever a probability beats a guess.",
      "One call, one state, many questions: batch every question about the same state, including speculative ones, and decide in your own reasoning what is relevant.",
      "For per-item questions over many items (lines of a file, records in an array), set split so each item is judged on its own; never pre-judge items yourself and ask Jev to confirm.",
      "Structure helps: state and instructions may be JSON objects with labelled keys; choice descriptions may be {what, not_for, examples}.",
    ].join(" "),
    parameters: jevSchema,
    unavailable: "Jev is not available in this conversation.",
    run: async (readState, args, signal) => {
      const questions: JevQuestions = {};
      for (const [id, question] of Object.entries(args.questions)) {
        questions[id] = toJevQuestion(id, question);
      }
      const state = await loadState(args, readState);
      if (typeof state === "string" && !state.trim()) throw new Error("State is empty");

      const payload = args.split
        ? await runSplit(state, args.split, args.context as JevEntry | undefined, questions, signal)
        : await runSingle(state, questions, signal);

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: undefined,
      };
    },
  });

  return { tool, setStateReader: setFn };
}
