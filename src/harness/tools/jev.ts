import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import {
  evaluateWithJev,
  JevNotConfiguredError,
  type JevEntry,
  type JevQuestion,
  type JevQuestions,
} from "../jev.js";
import { isRecord } from "../../unknown-values.js";

export const JEV_TOOL = "jev";

const entrySchema = Type.Any({
  description: "Text, or a JSON object or array. Jev reads structure, so labelled keys help.",
});

const questionSchema = Type.Object({
  type: Type.Union([Type.Literal("boolean"), Type.Literal("choice"), Type.Literal("score")], {
    description:
      "boolean: yes/no, answered as a probability 0-1. choice: pick one option from a set; answered with a probability per option and a confidence. score: place the state on an ordered rubric; answered with a score (fractional between levels), a probability per level, and a confidence.",
  }),
  instructions: entrySchema,
  criteria: Type.Optional(
    Type.Any({
      description:
        'choice (required): object mapping option id -> description (string, JSON, or null when the id is self-explanatory). score (required): array of level descriptions, lowest first. boolean (optional): {"true": description of yes, "false": description of no}.',
    }),
  ),
});

const jevSchema = Type.Object({
  label: Type.String({ description: "Brief description of the judgment (shown to user)" }),
  state: entrySchema,
  questions: Type.Record(Type.String(), questionSchema, {
    description:
      "Questions keyed by id. Every question is evaluated independently against the same state in one request.",
    minProperties: 1,
  }),
});

type QuestionArg = Static<typeof questionSchema>;

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

export function createJevTool(): AgentTool<typeof jevSchema> {
  return {
    name: JEV_TOOL,
    label: JEV_TOOL,
    description: [
      "Ask Jev, a fast calibrated decision model, typed questions about a state. Jev never generates text; it returns probabilities.",
      "state: the material to judge — text, or a JSON object/array (prefer labelled keys). questions: any number of boolean / choice / score questions, all evaluated against that state in one request.",
      "Use it for classification, detection, scoring, ranking, routing, extraction over known candidates, and verification — anywhere you would otherwise judge by eye.",
      "Ask narrow, atomic questions and batch them: to rank N items, ask one score question per item (not one choice over orderings); to verify a summary, ask one boolean per claim.",
      "choice and score answers carry a confidence; below 0.5 Jev is unsure between options, so say so instead of presenting the top option as settled.",
    ].join(" "),
    parameters: jevSchema,
    execute: async (_toolCallId, args, signal) => {
      if (signal?.aborted) throw new Error("Operation aborted");
      const questions: JevQuestions = {};
      for (const [id, question] of Object.entries(args.questions)) {
        questions[id] = toJevQuestion(id, question);
      }

      let result;
      try {
        result = await evaluateWithJev(args.state as JevEntry, questions, {
          abortSignal: signal,
          caller: "jev_tool",
        });
      } catch (error) {
        if (error instanceof JevNotConfiguredError) {
          throw new Error(
            "Jev is not configured (OPENROUTER_API_KEY missing). Judge the input yourself.",
            { cause: error },
          );
        }
        throw error;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { answers: result.answers, model: result.model, usage: result.usage },
              null,
              2,
            ),
          },
        ],
        details: undefined,
      };
    },
  };
}
