/**
 * Workflow rows shipped with the code.
 *
 * A workflow is data, so in principle these are admin-editable rows. They are
 * seeded from here so a fresh install has a working pipeline rather than an
 * empty table, and re-seeding never clobbers an edit: an existing row is left
 * exactly as it is, because the whole point of `prompt` being data is that
 * someone can change it without a deploy.
 *
 * Changing a seed therefore only affects installs that have not seen that
 * key yet. Editing a live workflow is a data edit plus a new
 * `WorkflowVersion`, which is what makes a run attributable to the prompt
 * that produced it.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../clock.js";

interface WorkflowSeed {
  key: string;
  name: string;
  description: string;
  trigger: object;
  scope: "event" | "sweep";
  creates: "task" | "event" | "delivery" | "nothing";
  prompt?: string;
  tools?: string[];
  priority?: number;
}

function seedsFor(heartbeatHour: number): WorkflowSeed[] {
  return [
    {
      key: "pipeline_heartbeat",
      name: "Pipeline heartbeat",
      description: "Daily proof of life with queue depth and failure counts",
      // A sweep triggered by the clock: the handler queries the database, so
      // the tick only has to say when it is.
      //
      // Deliberately not gated on `isSendDay`. A heartbeat's whole value is
      // that silence means something is broken, so it has to fire on weekends
      // and holidays too — otherwise a pipeline that died on Friday evening
      // looks healthy until Monday. The holiday gate belongs on digests and
      // reminders, which are addressed to people who are not at work.
      trigger: {
        kind: ["clock.tick"],
        payload_equals: { hour: heartbeatHour },
      },
      scope: "sweep",
      creates: "delivery",
      priority: 10,
    },
  ];
}

/** Insert any seed whose key is absent. Existing rows are never modified. */
export function seedWorkflows(db: DatabaseSync, heartbeatHour: number): number {
  const SEEDS = seedsFor(heartbeatHour);
  const now = nowIso();
  let inserted = 0;

  for (const seed of SEEDS) {
    const result = db
      .prepare(
        `INSERT INTO workflows (key, name, description, trigger, prompt, tools, creates, scope, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO NOTHING`,
      )
      .run(
        seed.key,
        seed.name,
        seed.description,
        JSON.stringify(seed.trigger),
        seed.prompt ?? "",
        JSON.stringify(seed.tools ?? []),
        seed.creates,
        seed.scope,
        seed.priority ?? 100,
        now,
        now,
      );
    if (result.changes === 0) continue;
    inserted++;

    // Version 1 exists from the start: a WorkflowVersion written later than
    // the first WorkflowRun leaves those early runs permanently unattributable,
    // and feedback cannot be backfilled.
    db.prepare(
      `INSERT INTO workflow_versions (workflow_id, version, prompt, tools, source, created_at)
       VALUES ((SELECT id FROM workflows WHERE key = ?), 1, ?, ?, 'manual', ?)`,
    ).run(seed.key, seed.prompt ?? "", JSON.stringify(seed.tools ?? []), now);
  }

  return inserted;
}
