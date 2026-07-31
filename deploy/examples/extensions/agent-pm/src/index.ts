/**
 * agent-pm — an event-driven team-operations pipeline, as a mikan extension.
 *
 * The shape is Event → Workflow → Task → Feedback:
 *
 *   Everything that happens — a chat message, a repository change, a calendar
 *   entry, a clock tick — lands as one immutable `Event`. Registered
 *   `Workflow` rows (a trigger, a prompt, and a declared tool list) match
 *   events and run; when something needs a person, they produce a `Task`. The
 *   person works it and says whether the agent was right, and that judgement
 *   is `Feedback` that shapes the next run of the same workflow. Human replies
 *   come back in as Events, so the loop closes without a separate tracking
 *   stage.
 *
 * Four callback schedules drive it (`ingest_events`, `run_workflows`,
 * `sweep_tasks`, `improve_workflows`). Callback schedules run host-side code
 * deterministically — no agent run, no model call, no token spend — which is
 * what makes a pipeline like this affordable to run every few minutes.
 *
 * This is a substantial example: it shows storage, scheduling, deterministic
 * dispatch, proactive delivery, and structured-output model calls together.
 * For the minimal shape of an extension, read `../poll` first.
 *
 * Two things worth copying regardless of what you build:
 *
 * - **`deliveryMode` defaults to `test`.** Every outbound message is
 *   divertible to one conversation until an operator says otherwise. An
 *   extension that notifies people is one config mistake away from notifying
 *   all of them twice.
 * - **Schedules are owned by exactly one conversation.** `activate` runs once
 *   per conversation, so without that check every conversation the extension
 *   is installed in registers its own copy of the daily jobs.
 */
import type { MikanExtensionApi } from "@geminixiang/mikan";
import { nowIso, taipeiDate } from "./clock.js";
import { configPath, loadConfig, ownsSchedules } from "./config.js";
import type { PipelineContext } from "./context.js";
import { openDb, type TaskOutcome, type TaskRow } from "./db.js";
import { eventsForSubject } from "./store.js";
import { taskUrn } from "./urn.js";
import { ensureSources, ingestEvents } from "./pipeline/ingest.js";
import { runWorkflows } from "./pipeline/run.js";
import { sweepTasks } from "./pipeline/sweep.js";
import { seedWorkflows } from "./workflows/seeds.js";

/**
 * Callback schedules owned by the control conversation. Cron only — no
 * resident worker, no webhook, no queue — so the pipeline's floor latency is
 * the interval, which is the accepted cost of that constraint.
 */
const SCHEDULES = [
  { name: "ingest-events", schedule: "*/10 * * * *" },
  { name: "run-workflows", schedule: "*/5 * * * *" },
  { name: "sweep-tasks", schedule: "0 * * * *" },
] as const;

export default async function activate(api: MikanExtensionApi): Promise<void> {
  // Fail with a sentence someone can act on. Without this the first call to a
  // missing api member throws a bare TypeError, which reaches the user as
  // "the bot says it only has a skill" — a symptom that looks nothing like
  // "your mikan is too old".
  if (typeof api.schedules?.onCallback !== "function") {
    throw new Error(
      "agent-pm needs callback schedules (mikan >= 1.0.0-beta.40). " +
        "Upgrade mikan, restart it, then run /pi-new in this conversation.",
    );
  }

  const dataDir = api.paths.sharedDataDir;
  const db = openDb(dataDir);
  const config = loadConfig(dataDir);
  ensureSources(db);
  const seeded = seedWorkflows(db, config.heartbeatHour);
  api.onDispose(() => db.close());

  const ctx: PipelineContext = { db, api, config, log: (message) => api.log(message) };
  if (seeded > 0) ctx.log(`seeded ${seeded} workflow(s)`);

  api.schedules.onCallback("ingest-events", async () => {
    const { created, failed } = await ingestEvents(ctx);
    if (created > 0 || failed.length > 0) {
      ctx.log(
        `ingest: ${created} new event(s)${failed.length > 0 ? `, ${failed.length} source(s) failed` : ""}`,
      );
    }
  });

  api.schedules.onCallback("run-workflows", async () => {
    const summary = await runWorkflows(ctx);
    if (summary.processed > 0) {
      ctx.log(
        `run: ${summary.processed} event(s) — ${summary.dispatched} dispatched, ` +
          `${summary.skipped} unmatched, ${summary.failed} failed`,
      );
    }
  });

  api.schedules.onCallback("sweep-tasks", async () => {
    const summary = await sweepTasks(ctx);
    if (summary.overdue > 0 || summary.nudgeDue > 0) {
      ctx.log(`sweep: ${summary.overdue} overdue, ${summary.nudgeDue} nudge-due`);
    }
  });

  if (ownsSchedules(config, api.context.conversationId)) {
    for (const entry of SCHEDULES) {
      await api.schedules.upsert(entry.name, {
        type: "periodic",
        schedule: config.scheduleOverrides[entry.name] ?? entry.schedule,
        timezone: "Asia/Taipei",
        callback: entry.name,
      });
    }
    ctx.log(`schedules registered (${SCHEDULES.length}); delivery mode: ${config.deliveryMode}`);
  } else if (config.controlConversationId === "") {
    ctx.log(
      `no controlConversationId set — schedules are not running. ` +
        `Set it to this conversation (${api.context.conversationId}) in ${configPath(dataDir)}`,
    );
  }

  // The agent's read/close view of the queue. Workflows create tasks; a
  // person works them, and the agent is how they usually ask. Parameters are
  // plain JSON Schema — extensions do not depend on typebox — so the object
  // is cast at the call site and validated by the runtime.
  api.registerTool({
    name: "pm_task",
    label: "Tasks",
    description:
      "Read and close pipeline tasks: work items a workflow decided needed a person. " +
      "Call this before answering anything about outstanding, blocked, or overdue work.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "show", "close"],
          description: "list: open tasks · show: one task with its history · close: finish one",
        },
        id: { type: "integer", description: "Task id (show, close)" },
        outcome: {
          type: "string",
          enum: ["resolved", "no_action_needed", "invalid", "superseded"],
          description:
            "close: how it ended. no_action_needed and invalid record that the task " +
            "should not have existed, which is feedback that changes the workflow.",
        },
        note: { type: "string", description: "close: what closing it meant" },
      },
      required: ["action"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- plain JSON Schema, see above
    } as any,
    execute: async (_toolCallId: string, rawParams: unknown) => {
      const params = rawParams as {
        action: "list" | "show" | "close";
        id?: number;
        outcome?: TaskOutcome;
        note?: string;
      };
      return runTaskTool(ctx, params);
    },
  });

  api.registerCommand({
    name: "pm",
    description: "agent-pm: status, or run a pipeline stage now (ingest | run | sweep | all)",
    handler: async ({ args, respond }) => {
      const action = args.trim().toLowerCase() || "status";
      if (action === "status") {
        await respond(status(ctx, dataDir, api.context.conversationId));
        return;
      }
      if (!["ingest", "run", "sweep", "all"].includes(action)) {
        await respond(`Unknown action \`${action}\`. Use: status | ingest | run | sweep | all`);
        return;
      }

      // Manual triggering is how a stage is exercised without waiting for its
      // cron, which is what an end-to-end check needs and what an operator
      // reaches for when something looks stuck.
      const lines: string[] = [];
      if (action === "ingest" || action === "all") {
        const { created, failed } = await ingestEvents(ctx);
        lines.push(`ingest: ${created} new event(s), ${failed.length} source failure(s)`);
        for (const failure of failed) lines.push(`  • ${failure}`);
      }
      if (action === "run" || action === "all") {
        const summary = await runWorkflows(ctx);
        lines.push(
          `run: ${summary.processed} processed, ${summary.dispatched} dispatched, ` +
            `${summary.skipped} unmatched, ${summary.failed} failed`,
        );
      }
      if (action === "sweep" || action === "all") {
        const summary = await sweepTasks(ctx);
        lines.push(`sweep: ${summary.overdue} overdue, ${summary.nudgeDue} nudge-due`);
      }
      await respond(lines.join("\n"));
    },
  });

  ctx.log(`agent-pm ready (${api.context.conversationId})`);
}

type ToolReply = { content: { type: "text"; text: string }[]; details: unknown };

/** Standard tool content: one text block plus structured details. */
function text(value: string, details: unknown = {}): ToolReply {
  return { content: [{ type: "text", text: value }], details };
}

/**
 * The `pm_task` tool body. Closing writes `Feedback` when the outcome says the
 * task should never have existed — the human already told us by choosing that
 * outcome, and asking them a second time in a feedback form is how feedback
 * loops end up with no data in them.
 */
async function runTaskTool(
  ctx: PipelineContext,
  params: { action: "list" | "show" | "close"; id?: number; outcome?: TaskOutcome; note?: string },
): Promise<ToolReply> {
  if (params.action === "list") {
    const rows = ctx.db
      .prepare(
        `SELECT id, title, status, priority, due_at, queue, proposed_action
           FROM tasks WHERE status IN ('open', 'in_progress', 'blocked')
          ORDER BY due_at IS NULL, due_at, id LIMIT 50`,
      )
      .all() as Array<Pick<TaskRow, "id" | "title" | "status" | "priority" | "due_at" | "queue">>;
    if (rows.length === 0) return text("No open tasks.", { count: 0 });
    const lines = rows.map(
      (row) =>
        `#${row.id} [${row.status}${row.priority === "normal" ? "" : `/${row.priority}`}] ` +
        `${row.title}${row.due_at ? ` (due ${row.due_at.slice(0, 10)})` : ""}`,
    );
    return text(lines.join("\n"), { count: rows.length });
  }

  if (params.id === undefined) throw new Error(`${params.action} requires id`);

  if (params.action === "show") {
    const task = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(params.id) as
      | TaskRow
      | undefined;
    if (!task) throw new Error(`No task #${params.id}`);
    // The task's history is a query on the event table — transitions are
    // logged Events, so there is no separate audit model to consult.
    const history = eventsForSubject(ctx.db, taskUrn(task.id), 20);
    const lines = [
      `#${task.id} [${task.status}/${task.approval}] ${task.title}`,
      task.body && `\n${task.body}`,
      task.proposed_action && `\nproposed: ${task.proposed_action}`,
      task.progress_note && `\nlatest progress: ${task.progress_note}`,
      history.length > 0 &&
        `\nhistory:\n${history.map((event) => `  ${event.occurred_at.slice(0, 16)} ${event.kind} ${event.title}`).join("\n")}`,
    ].filter(Boolean);
    return text(lines.join("\n"), { id: task.id, status: task.status });
  }

  const outcome: TaskOutcome = params.outcome ?? "resolved";
  const closed = ctx.db
    .prepare(
      `UPDATE tasks SET status = 'done', outcome = ?, resolved_at = ?,
              progress_note = CASE WHEN ? = '' THEN progress_note ELSE ? END
        WHERE id = ? AND status != 'done'`,
    )
    .run(outcome, nowIso(), params.note ?? "", params.note ?? "", params.id);
  if (closed.changes === 0) throw new Error(`No open task #${params.id}`);

  if (outcome === "no_action_needed" || outcome === "invalid") {
    const task = ctx.db.prepare("SELECT origin_run_id FROM tasks WHERE id = ?").get(params.id) as
      | { origin_run_id: number | null }
      | undefined;
    ctx.db
      .prepare(
        `INSERT INTO feedback (task_id, run_id, workflow_id, dimension, verdict, note, capture, created_at)
         VALUES (?, ?, (SELECT workflow_id FROM workflow_runs WHERE id = ?), 'existence', 'wrong', ?, 'implicit', ?)`,
      )
      .run(
        params.id,
        task?.origin_run_id ?? null,
        task?.origin_run_id ?? null,
        params.note ?? "",
        nowIso(),
      );
  }

  return text(`Task #${params.id} closed (${outcome}).`, { id: params.id, outcome });
}

function status(ctx: PipelineContext, dataDir: string, conversationId: string): string {
  const counts = ctx.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM events   WHERE state = 'pending')   AS pending_events,
         (SELECT COUNT(*) FROM events   WHERE state = 'skipped')   AS skipped_events,
         (SELECT COUNT(*) FROM events)                             AS total_events,
         (SELECT COUNT(*) FROM tasks    WHERE status = 'open')     AS open_tasks,
         (SELECT COUNT(*) FROM workflows WHERE is_enabled = 1)     AS workflows,
         (SELECT COUNT(*) FROM deliveries WHERE status = 'sent')   AS sent,
         (SELECT COUNT(*) FROM workflow_runs WHERE status = 'failed') AS failed_runs`,
    )
    .get() as Record<string, number>;

  const owner = ownsSchedules(ctx.config, conversationId)
    ? "this conversation"
    : ctx.config.controlConversationId || "(unset — schedules idle)";
  const destination =
    ctx.config.deliveryMode === "test"
      ? ` → ${ctx.config.testConversationId || "(no test conversation set)"}`
      : "";

  return [
    `*agent-pm* — ${taipeiDate()} (Asia/Taipei)`,
    `delivery: \`${ctx.config.deliveryMode}\`${destination}`,
    `schedules owned by: ${owner}`,
    `events: ${counts.total_events} total · ${counts.pending_events} pending · ${counts.skipped_events} unmatched`,
    `tasks: ${counts.open_tasks} open · workflows: ${counts.workflows} enabled`,
    `deliveries sent: ${counts.sent} · failed runs: ${counts.failed_runs}`,
    `config: \`${configPath(dataDir)}\``,
  ].join("\n");
}
