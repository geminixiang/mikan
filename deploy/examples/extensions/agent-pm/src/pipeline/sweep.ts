/**
 * `sweep_tasks` — turn the passage of time into events.
 *
 * This stage only ever *emits* events; it never notifies anyone. That is what
 * lets escalation and nagging be workflows whose thresholds and wording are
 * tunable data, instead of a cadence engine welded into a cron command where
 * changing "nag every third day" means a deploy.
 */
import type { PipelineContext } from "../context.js";
import { nowIso } from "../clock.js";
import type { TaskRow } from "../db.js";
import { insertEvent } from "../store.js";
import { taskUrn } from "../urn.js";

export interface SweepSummary {
  overdue: number;
  nudgeDue: number;
}

/**
 * Emit one event per task that has become due or is ready for another nudge.
 *
 * `external_id` carries the day, so re-running the sweep within a day is a
 * no-op while tomorrow's pass emits again — a task stays overdue until it is
 * closed, and one event per day is the intended nag cadence.
 */
export async function sweepTasks(ctx: PipelineContext): Promise<SweepSummary> {
  const now = nowIso();
  const day = now.slice(0, 10);
  const summary: SweepSummary = { overdue: 0, nudgeDue: 0 };

  const overdue = ctx.db
    .prepare(
      `SELECT * FROM tasks
        WHERE status IN ('open', 'in_progress')
          AND due_at IS NOT NULL
          AND due_at <= ?
        ORDER BY due_at`,
    )
    .all(now) as TaskRow[];

  for (const task of overdue) {
    const created = insertEvent(ctx.db, {
      sourceKey: "clock",
      externalId: `task-overdue:${task.id}:${day}`,
      kind: "task.overdue",
      subject: taskUrn(task.id),
      actorRole: "system",
      title: task.title,
      payload: { taskId: task.id, dueAt: task.due_at, queue: task.queue },
    });
    if (created !== undefined) summary.overdue++;
  }

  const nudgeDue = ctx.db
    .prepare(
      `SELECT * FROM tasks
        WHERE status IN ('open', 'in_progress')
          AND nudge_interval_seconds IS NOT NULL
          AND (
            last_nudged_at IS NULL
            OR datetime(last_nudged_at, '+' || nudge_interval_seconds || ' seconds') <= datetime(?)
          )
        ORDER BY id`,
    )
    .all(now) as TaskRow[];

  for (const task of nudgeDue) {
    const created = insertEvent(ctx.db, {
      sourceKey: "clock",
      externalId: `task-nudge:${task.id}:${day}`,
      kind: "task.nudge_due",
      subject: taskUrn(task.id),
      actorRole: "system",
      title: task.title,
      payload: {
        taskId: task.id,
        lastNudgedAt: task.last_nudged_at,
        intervalSeconds: task.nudge_interval_seconds,
      },
    });
    if (created !== undefined) summary.nudgeDue++;
  }

  return summary;
}
