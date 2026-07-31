/**
 * The code half of a workflow.
 *
 * A `Workflow` row is a prompt plus a declared tool list; this registry is
 * what those declarations resolve to. Composing existing behaviour into a new
 * one is a new row (no deploy); a genuinely new capability is an entry here
 * (a deploy, and rare). A row whose `key` has no entry here and no prompt
 * cannot do anything, and `run_workflows` says so rather than reporting a
 * silent success.
 */
import { taipeiDate } from "../clock.js";
import { deliver } from "../delivery.js";
import type { WorkflowHandler } from "../pipeline/run.js";

/**
 * Proof of life, and the end-to-end path every other workflow will use:
 * clock tick → sweep workflow → Delivery → Slack. Deliberately the first
 * workflow to exist, because it exercises delivery dedup and test-mode
 * routing without needing any seeded identity data.
 */
const heartbeat: WorkflowHandler = async (ctx, event, _workflow, runId) => {
  const date = taipeiDate();
  const counts = ctx.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM events WHERE state = 'pending')         AS pending_events,
         (SELECT COUNT(*) FROM events WHERE state = 'skipped')         AS skipped_events,
         (SELECT COUNT(*) FROM tasks  WHERE status = 'open')           AS open_tasks,
         (SELECT COUNT(*) FROM workflow_runs WHERE status = 'failed')  AS failed_runs`,
    )
    .get() as {
    pending_events: number;
    skipped_events: number;
    open_tasks: number;
    failed_runs: number;
  };

  const text = [
    `:heartbeat: *agent-pm* — ${date}`,
    `events pending ${counts.pending_events} · skipped ${counts.skipped_events}`,
    `tasks open ${counts.open_tasks} · failed runs ${counts.failed_runs}`,
  ].join("\n");

  const result = await deliver(ctx, {
    target: "slack.post",
    conversationId: ctx.config.controlConversationId,
    text,
    // One heartbeat per Taipei day, whatever the schedule does.
    dedupeKey: `heartbeat:${date}`,
    runId,
  });

  return {
    output: { date, delivery: result.status, ...counts },
    summary: `heartbeat ${result.status}`,
  };
};

export const HANDLERS: Record<string, WorkflowHandler> = {
  pipeline_heartbeat: heartbeat,
};
