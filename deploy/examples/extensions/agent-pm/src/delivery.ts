/**
 * The single outbound log. Inbound is one table, outbound is one table.
 *
 * Everything agent-pm sends — a digest, a nag, a task notification — goes
 * through `deliver`, which means three properties hold everywhere rather than
 * per call site:
 *
 * 1. **A duplicate send is rejected by the database.** `dedupe_key` is a
 *    unique index, so a re-run posts nothing rather than double-notifying.
 * 2. **`deliveryMode: "test"` diverts every message to one conversation**,
 *    labelled with where it would have gone — which is what makes it safe to
 *    run this beside whatever it replaces, or to tune a new workflow without
 *    an audience.
 * 3. **The platform message id is recorded** as `external_ref`, which is what
 *    lets a human's thread reply be read back and tied to the task that
 *    caused it.
 */
import type { PipelineContext } from "./context.js";
import { nowIso } from "./clock.js";

export interface DeliverRequest {
  /** `slack.post` for a top-level message, `slack.thread` for a reply. */
  target: "slack.post" | "slack.thread";
  /** The conversation this is *meant* for, before any test-mode diversion. */
  conversationId: string;
  text: string;
  /** Required for `slack.thread`: the parent message to reply under. */
  threadTs?: string;
  /**
   * Idempotency key, e.g. `digest:2026-07-30:C0123`. Omit only for messages
   * that are genuinely safe to repeat.
   */
  dedupeKey?: string;
  taskId?: number;
  runId?: number;
}

export interface DeliverResult {
  status: "sent" | "duplicate" | "failed";
  /** The posted message's platform id — the thread anchor for replies. */
  externalRef?: string;
  error?: string;
}

/**
 * Send one message, recording it either way.
 *
 * Failures are recorded and returned, never thrown: one channel being
 * unreachable must not abort a digest run that still has nine channels to
 * post to.
 */
export async function deliver(
  ctx: PipelineContext,
  request: DeliverRequest,
): Promise<DeliverResult> {
  const dedupeKey = request.dedupeKey ?? null;

  // Claim the key first. The unique index — not this read — is what actually
  // prevents a double send; inserting first means two concurrent runs cannot
  // both pass a check and then both post.
  const claimed = ctx.db
    .prepare(
      `INSERT INTO deliveries (task_id, run_id, target, address, dedupe_key, request, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
    )
    .run(
      request.taskId ?? null,
      request.runId ?? null,
      request.target,
      JSON.stringify({
        conversationId: request.conversationId,
        ...(request.threadTs ? { threadTs: request.threadTs } : {}),
      }),
      dedupeKey,
      JSON.stringify({ text: request.text }),
      nowIso(),
    );

  if (claimed.changes === 0) {
    return { status: "duplicate" };
  }
  const deliveryId = Number(claimed.lastInsertRowid);

  const routed = route(ctx, request);
  try {
    const externalRef = await ctx.api.notify(routed.text, {
      conversationId: routed.conversationId,
      ...(routed.threadTs ? { threadTs: routed.threadTs } : {}),
    });
    ctx.db
      .prepare(
        `UPDATE deliveries SET status = 'sent', external_ref = ?, sent_at = ?, response = ? WHERE id = ?`,
      )
      .run(
        externalRef,
        nowIso(),
        JSON.stringify({ conversationId: routed.conversationId }),
        deliveryId,
      );
    return { status: "sent", externalRef };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The row stays, marked failed: a send that never happened has to be
    // visible, and leaving the dedupe key claimed would silently suppress the
    // retry. Clearing it is deliberate.
    ctx.db
      .prepare(`UPDATE deliveries SET status = 'failed', error = ?, dedupe_key = NULL WHERE id = ?`)
      .run(message.slice(0, 2000), deliveryId);
    ctx.log(`delivery failed (${request.target} → ${request.conversationId}): ${message}`);
    return { status: "failed", error: message };
  }
}

/**
 * Where the message actually goes. In `test` mode everything lands in the
 * test conversation with a header naming the real target, so a reviewer can
 * check what would have been sent without anything reaching a team.
 *
 * A thread reply cannot be diverted meaningfully — its parent lives in the
 * original conversation — so in test mode it becomes a top-level message that
 * says which thread it belonged to.
 */
function route(
  ctx: PipelineContext,
  request: DeliverRequest,
): { conversationId: string; text: string; threadTs?: string } {
  if (ctx.config.deliveryMode === "live") {
    return {
      conversationId: request.conversationId,
      text: request.text,
      ...(request.threadTs ? { threadTs: request.threadTs } : {}),
    };
  }
  const destination = ctx.config.testConversationId;
  if (!destination) {
    throw new Error(
      "deliveryMode is 'test' but testConversationId is unset — refusing to post to the real target",
    );
  }
  const label = request.threadTs
    ? `→ ${request.conversationId} (thread ${request.threadTs})`
    : `→ ${request.conversationId}`;
  return {
    conversationId: destination,
    text: `_[agent-pm test ${label}]_\n${request.text}`,
  };
}

/** The delivery that carried `externalRef`, for tying a reply back to a task. */
export function deliveryByExternalRef(
  ctx: PipelineContext,
  externalRef: string,
): { id: number; task_id: number | null; run_id: number | null } | undefined {
  return ctx.db
    .prepare(
      "SELECT id, task_id, run_id FROM deliveries WHERE external_ref = ? AND status = 'sent'",
    )
    .get(externalRef) as { id: number; task_id: number | null; run_id: number | null } | undefined;
}
