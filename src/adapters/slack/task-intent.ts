import { evaluateWithJev, JevNotConfiguredError } from "../../harness/index.js";
import { reportUserFacingError } from "../../observability/index.js";
import * as log from "../../log.js";
import type { TaskStatus } from "../../types.js";
import {
  formatRecentScope,
  humanizeMentions,
  readRecentScope,
  type SlackNameResolver,
} from "./jev-context.js";
import { isTaskStatusQuestion } from "./task-status.js";

export type TaskIntent = "status" | "steer" | "request";

const TASK_INTENT_CRITERIA = {
  status:
    "Only asks whether the ongoing work is done, how it is going, what step it is on, or how long it will take. Contains no new instruction, constraint, correction, or request for content.",
  steer:
    "Adds information, a constraint, a correction, or a change of direction for the ongoing work while it continues (e.g. 先不要部署, also check the staging config, use the other branch). May be combined with a progress question.",
  request:
    "A new standalone question or request unrelated to steering the ongoing work, a reaction to a finished result, or anything else.",
} as const;

export function buildTaskIntentState(
  conversationDir: string,
  event: { ts: string; thread_ts?: string; user: string; text: string },
  options: {
    speaker?: string;
    tasks: TaskStatus[];
    resolveName?: SlackNameResolver;
    botUserId?: string | null;
  },
): string {
  const resolve = options.resolveName ?? (() => undefined);
  const humanize = (text: string) => humanizeMentions(text, resolve, options.botUserId ?? null);
  const recent = readRecentScope(conversationDir, event, { humanize });
  const tasks = options.tasks.length
    ? options.tasks
        .map(
          (t) =>
            `- ${t.status}${t.currentTool ? ` (currently: ${t.currentTool})` : ""}: ${t.acknowledgement}`,
        )
        .join("\n")
    : "(none)";
  return [
    event.thread_ts
      ? "Slack DM reply inside a background task thread."
      : "Slack DM top-level message while background tasks exist.",
    "",
    "Tasks in this DM (most recent first):",
    tasks,
    "",
    "Recent messages in this scope (oldest first):",
    formatRecentScope(recent),
    "",
    `NEW message from ${options.speaker ?? event.user}:`,
    humanize(event.text),
  ].join("\n");
}

export async function classifyTaskIntent(
  state: string,
  text: string,
  context: { conversationId: string; inTaskThread: boolean },
): Promise<TaskIntent> {
  const fallback = (): TaskIntent =>
    isTaskStatusQuestion(text) ? "status" : context.inTaskThread ? "steer" : "request";
  try {
    const result = await evaluateWithJev(
      state,
      {
        intent: {
          type: "choice",
          instructions:
            "Given the tasks in play and the recent conversation, what does the NEW message mean?",
          criteria: TASK_INTENT_CRITERIA,
        },
      },
      { caller: "task_intent" },
    );
    const choice = result.answers.intent.choice;
    const probabilities = result.answers.intent.probabilities;
    log.logInfo(
      `[${context.conversationId}] jev task intent: ${choice}${
        probabilities ? ` ${JSON.stringify(probabilities)}` : ""
      } text="${text.slice(0, 80)}"`,
    );
    if (choice === "status" || choice === "steer" || choice === "request") return choice;
    return fallback();
  } catch (err) {
    if (!(err instanceof JevNotConfiguredError)) {
      reportUserFacingError(err, {
        domain: "chat_platform",
        surface: "slack_task_intent_jev",
        operation: "evaluate",
        severity: "warning",
        context: { conversationId: context.conversationId },
      });
    }
    return fallback();
  }
}
