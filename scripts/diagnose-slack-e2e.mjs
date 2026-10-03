import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OfficeRegistry, createWorkspace } from "../dist/office/index.js";
import { SessionStore } from "../dist/sessions/session-store.js";
const [root, stateDir] = process.argv.slice(2);
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
}

if (stateDir && existsSync(stateDir)) {
  const workspace = createWorkspace({ root, stateDir });
  for (const record of new OfficeRegistry(stateDir).getOffices()) {
    const office = workspace.office(record);
    for (const session of await SessionStore.list(office)) {
      await inspectSession(office, session.key);
    }
  }
}

async function inspectSession(office, file) {
  try {
    const inspection = await SessionStore.inspect(office, file);
    for (const entry of (await inspection?.getEntries()) ?? []) {
      if (entry.type !== "message") continue;
      const m = entry.message;
      console.log(
        JSON.stringify({
          kind: "session",
          office: office.key,
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
    console.log(
      JSON.stringify({ kind: "inspection_failed", office: office.key, file, errorType: e.name }),
    );
  }
}
