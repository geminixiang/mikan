/**
 * `ingest_events` — the only stage that reads anything outside the database,
 * and therefore the only stage with a cursor.
 *
 * Every source writes `Event(state=pending)` and advances its own cursor.
 * Nothing here judges, routes, or notifies: an inbound signal is written
 * unconditionally even when nothing about it is understood yet, so there is
 * no parse failure that loses data. Sources deliberately re-read an overlap
 * window, and the duplicates that causes are absorbed by the
 * `(source, external_id)` idempotency key.
 */
import type { DatabaseSync } from "node:sqlite";
import { taipeiDate, weekdayOf, isSendDay } from "../clock.js";
import type { PipelineContext } from "../context.js";
import {
  ensureSource,
  enabledSources,
  insertEvent,
  markSourceFailure,
  markSourceSuccess,
} from "../store.js";

/** One source's read. Returns how many new events it landed. */
export type SourceIngestor = (ctx: PipelineContext) => Promise<number>;

const HOUR_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Taipei",
  hour: "2-digit",
  hour12: false,
});

/**
 * The heartbeat. One event per Taipei hour, which is what sweep workflows
 * (assignment, digests, nags) trigger on — they query the database rather
 * than read this payload, so the tick only has to say *when* it is.
 *
 * `external_id` is the hour bucket, so ingest running every ten minutes still
 * produces exactly one tick per hour and a re-run cannot double-fire a daily
 * job. Clock events need no special case anywhere else because of this.
 */
const ingestClock: SourceIngestor = async (ctx) => {
  const date = taipeiDate();
  const hour = HOUR_FORMAT.format(new Date());
  const created = insertEvent(ctx.db, {
    sourceKey: "clock",
    externalId: `${date}T${hour}`,
    kind: "clock.tick",
    subject: "system:clock",
    actorRole: "system",
    title: `clock ${date} ${hour}:00 Asia/Taipei`,
    payload: {
      date,
      hour: Number(hour),
      weekday: weekdayOf(date),
      // Resolved here, once, so no workflow re-derives the holiday rule.
      isSendDay: isSendDay(ctx.db, date),
    },
  });
  return created === undefined ? 0 : 1;
};

/**
 * The source registry. Adding a feed is adding an entry here plus a row in
 * `event_sources`; a source absent from the table never runs, and a source
 * disabled in config never runs, so turning one feed off is a data edit.
 */
const SOURCES: Record<string, { kind: "poll" | "clock"; ingest: SourceIngestor }> = {
  clock: { kind: "clock", ingest: ingestClock },
};

/** Register every known source. Idempotent; existing cursors are preserved. */
export function ensureSources(db: DatabaseSync): void {
  for (const [key, source] of Object.entries(SOURCES)) {
    ensureSource(db, { key, kind: source.kind, cursor_kind: "none" });
  }
}

/**
 * Run every enabled source. One source failing is recorded on that source and
 * does not stop the others: a GitHub outage must not also stop the clock.
 */
export async function ingestEvents(
  ctx: PipelineContext,
): Promise<{ created: number; failed: string[] }> {
  ensureSources(ctx.db);
  let created = 0;
  const failed: string[] = [];

  for (const row of enabledSources(ctx.db)) {
    const source = SOURCES[row.key];
    if (!source) continue;
    if (ctx.config.disabledSources.includes(row.key)) continue;
    try {
      created += await source.ingest(ctx);
      markSourceSuccess(ctx.db, row.key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markSourceFailure(ctx.db, row.key, message);
      failed.push(`${row.key}: ${message}`);
      ctx.log(`ingest source failed (${row.key}): ${message}`);
    }
  }

  return { created, failed };
}
