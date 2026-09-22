import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../dist/sessions/session-store.js";
const root = process.argv[2];
if (!root || !existsSync(root)) process.exit(0);
const markers = (value) => [
  ...new Set(
    (typeof value === "string" ? value : (JSON.stringify(value) ?? "")).match(/QA_[A-Z0-9_]+/g) ??
      [],
  ),
];
for (const office of readdirSync(root)) {
  const log = join(root, office, "log.jsonl");
  if (!existsSync(log)) continue;
  for (const line of readFileSync(log, "utf8").split("\n").filter(Boolean)) {
    try {
      const x = JSON.parse(line);
      console.log(
        JSON.stringify({
          kind: "intake",
          office,
          ts: x.ts,
          threadTs: x.threadTs,
          bot: x.isMessagingBot,
          markers: markers(x.text),
          attachments: x.attachments?.map((a) => ({
            name: a.original ?? a.name,
            path: a.localPath,
          })),
        }),
      );
    } catch {}
  }
  const dir = join(root, office, "sessions");
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    await inspectSession(dir, file, office);
  }
}

async function inspectSession(dir, file, office) {
  try {
    const inspection = await SessionStore.inspect(join(dir, file));
    for (const entry of await inspection.getEntries()) {
      if (entry.type !== "message") continue;
      const m = entry.message;
      console.log(
        JSON.stringify({
          kind: "session",
          office,
          file,
          id: entry.id,
          role: m.role,
          timestamp: m.timestamp,
          markers: markers(m.content),
          stopReason: m.stopReason,
          toolName: m.toolName,
          toolCalls: Array.isArray(m.content)
            ? m.content
                .filter((p) => p.type === "toolCall")
                .map((p) => ({ name: p.name, markers: markers(p.arguments) }))
            : undefined,
        }),
      );
    }
  } catch (e) {
    console.log(JSON.stringify({ kind: "inspection_failed", office, file, errorType: e.name }));
  }
}
