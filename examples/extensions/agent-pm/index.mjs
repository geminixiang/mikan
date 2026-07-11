/**
 * agent-pm — follow-up tracker as a mikan extension.
 *
 * Demonstrates the extension surface end to end:
 *   v1  registerTool          `followup` tool the model calls to manage items
 *   v1  before_agent_start    open items ride into every turn's system prompt
 *   v2  api.paths.dataDir     sqlite file in the extension's host-only data dir
 *   v2  api.schedules         daily overdue sweep as an autonomous agent run
 *   v2  api.notify            immediate out-of-band reminder ("remind" action)
 *   v2  manifest.json         name/version/description
 *   v2  skills/               follow-up-triage SKILL.md, inlined into the prompt
 *
 * Zero npm dependencies: storage is node:sqlite (built into Node >= 22.5).
 *
 * Install (all conversations):
 *   cp -r agent-pm ~/.mikan/extensions/global/
 * Install (one conversation):
 *   cp -r agent-pm ~/.mikan/extensions/<conversationId>/
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

function openDb(dataDir) {
  const db = new DatabaseSync(join(dataDir, "agent-pm.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS followups (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      title           TEXT NOT NULL,
      note            TEXT,
      due             TEXT,             -- YYYY-MM-DD, optional
      status          TEXT NOT NULL DEFAULT 'open',  -- open | done | cancelled
      created_at      TEXT NOT NULL,
      closed_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_followups_conv_status
      ON followups (conversation_id, status);
  `);
  return db;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function formatItem(row) {
  const due = row.due
    ? row.due < today()
      ? ` (due ${row.due} — OVERDUE)`
      : ` (due ${row.due})`
    : "";
  const note = row.note ? ` — ${row.note}` : "";
  return `#${row.id} [${row.status}] ${row.title}${due}${note}`;
}

/** Plain JSON Schema — no typebox import needed inside an extension. */
const followupSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["add", "list", "done", "cancel", "note", "remind"],
      description:
        "add: create a follow-up · list: show items · done/cancel: close an item · " +
        "note: append a note · remind: post open items to the channel right now",
    },
    title: { type: "string", description: "Item title (add)" },
    due: { type: "string", description: "Due date YYYY-MM-DD (add, optional)" },
    id: { type: "integer", description: "Item id (done / cancel / note)" },
    note: { type: "string", description: "Note text (add optional, note required)" },
    all: { type: "boolean", description: "list: include closed items (default open only)" },
  },
  required: ["action"],
};

export default async function activate(api) {
  const db = openDb(api.paths.dataDir);
  const conversationId = api.context.conversationId;

  const openItems = () =>
    db
      .prepare(
        `SELECT * FROM followups WHERE conversation_id = ? AND status = 'open'
         ORDER BY due IS NULL, due, id`,
      )
      .all(conversationId);

  api.registerTool({
    name: "followup",
    label: "Follow-ups",
    description:
      "Track follow-up items for this conversation: things promised, blocked, or to be revisited. " +
      "Add an item whenever the user or you commit to a future action; close it when resolved.",
    parameters: followupSchema,
    execute: async (_toolCallId, params) => {
      switch (params.action) {
        case "add": {
          if (!params.title) throw new Error("add requires title");
          const { lastInsertRowid } = db
            .prepare(
              `INSERT INTO followups (conversation_id, title, note, due, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              conversationId,
              params.title,
              params.note ?? null,
              params.due ?? null,
              new Date().toISOString(),
            );
          return {
            content: [
              { type: "text", text: `Added follow-up #${lastInsertRowid}: ${params.title}` },
            ],
            details: { id: Number(lastInsertRowid) },
          };
        }
        case "list": {
          const rows = params.all
            ? db
                .prepare(
                  `SELECT * FROM followups WHERE conversation_id = ? ORDER BY status = 'open' DESC, due IS NULL, due, id`,
                )
                .all(conversationId)
            : openItems();
          const text = rows.length === 0 ? "No follow-ups." : rows.map(formatItem).join("\n");
          return { content: [{ type: "text", text }], details: { count: rows.length } };
        }
        case "done":
        case "cancel": {
          if (params.id === undefined) throw new Error(`${params.action} requires id`);
          const status = params.action === "done" ? "done" : "cancelled";
          const { changes } = db
            .prepare(
              `UPDATE followups SET status = ?, closed_at = ? WHERE id = ? AND conversation_id = ? AND status = 'open'`,
            )
            .run(status, new Date().toISOString(), params.id, conversationId);
          if (changes === 0)
            throw new Error(`No open follow-up #${params.id} in this conversation`);
          return {
            content: [{ type: "text", text: `Follow-up #${params.id} marked ${status}.` }],
            details: { id: params.id, status },
          };
        }
        case "note": {
          if (params.id === undefined || !params.note) throw new Error("note requires id and note");
          const row = db
            .prepare(`SELECT note FROM followups WHERE id = ? AND conversation_id = ?`)
            .get(params.id, conversationId);
          if (!row) throw new Error(`No follow-up #${params.id} in this conversation`);
          const merged = row.note ? `${row.note}\n${params.note}` : params.note;
          db.prepare(`UPDATE followups SET note = ? WHERE id = ?`).run(merged, params.id);
          return {
            content: [{ type: "text", text: `Note added to follow-up #${params.id}.` }],
            details: { id: params.id },
          };
        }
        case "remind": {
          // v2: post directly to the channel, outside the agent's own reply.
          const rows = openItems();
          if (rows.length === 0) {
            return { content: [{ type: "text", text: "No open follow-ups." }], details: {} };
          }
          await api.notify(`📌 Open follow-ups:\n${rows.map(formatItem).join("\n")}`);
          return {
            content: [{ type: "text", text: `Posted ${rows.length} open follow-up(s).` }],
            details: { count: rows.length },
          };
        }
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // Every turn starts with the open items in the system prompt, so the agent
  // can remind, chase, and close them without being asked.
  api.on("before_agent_start", (event) => {
    const rows = openItems();
    if (rows.length === 0) return undefined;
    const overdue = rows.filter((row) => row.due && row.due < today()).length;
    const lines = rows.map(formatItem).join("\n");
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n## Open follow-ups (agent-pm)\n` +
        `${rows.length} open${overdue > 0 ? `, ${overdue} OVERDUE` : ""} — proactively mention overdue items; ` +
        `close finished ones with the followup tool.\n${lines}`,
    };
  });

  // v2: daily sweep — an autonomous agent run fires even when nobody is
  // talking, so overdue items get chased without a human prompt.
  try {
    await api.schedules.upsert("daily-overdue-sweep", {
      type: "periodic",
      schedule: "0 9 * * *",
      timezone: "Asia/Taipei",
      text:
        "You are running a scheduled follow-up sweep. Call the followup tool " +
        "(action: list). If any items are OVERDUE, post a short reminder that " +
        "names each overdue item and asks for a status update. If nothing is " +
        "overdue, do not post anything.",
    });
  } catch (err) {
    // Outside mikan (or in a context without an event store) the sweep is
    // simply unavailable; the tool and prompt injection still work.
    api.log(`schedules unavailable, skipping daily sweep: ${err.message}`);
  }

  api.log(`agent-pm ready (${openItems().length} open follow-ups for ${conversationId})`);
}
