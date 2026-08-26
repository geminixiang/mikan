/**
 * scheduled-counter — the golden-path mikan extension.
 *
 * The smallest extension that exercises all three core surfaces:
 *   - one chat command   (`/counter`)            → registerCommand
 *   - one callback schedule (daily report)       → schedules.upsert + onCallback
 *   - one small state file (per-conversation)    → paths.dataDir
 *
 * Multi-tenant facts this example demonstrates (see docs/adr/0006):
 *   - `activate` runs once PER CONVERSATION, not once per process. State in
 *     `paths.dataDir` is this conversation's own; two conversations never
 *     share a count.
 *   - The callback schedule belongs to this conversation too — each
 *     conversation that activates the extension gets its own daily report.
 *   - `mikan.requires` in package.json declares the host capabilities this
 *     extension needs. A context that lacks them fails activation with one
 *     clear error instead of throwing at the first api call.
 *
 * Try it without any platform:  mikan ext dev deploy/examples/extensions/scheduled-counter
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MikanExtensionApi } from "@geminixiang/mikan";

interface CounterState {
  count: number;
}

function readState(file: string): CounterState {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as CounterState;
  } catch {
    return { count: 0 };
  }
}

export default async function activate(api: MikanExtensionApi): Promise<void> {
  const stateFile = join(api.paths.dataDir, "state.json");

  api.registerCommand({
    name: "counter",
    description: "Bump this conversation's counter (`/counter reset` to zero it)",
    handler: async ({ args, respond }) => {
      const state = args.trim() === "reset" ? { count: 0 } : readState(stateFile);
      if (args.trim() !== "reset") state.count += 1;
      writeFileSync(stateFile, JSON.stringify(state));
      await respond(`Counter: ${state.count}`);
    },
  });

  // Deterministic host-side handler: no agent run, no model call.
  api.schedules.onCallback("daily-report", async () => {
    const state = readState(stateFile);
    await api.notify(`📈 Daily counter report: ${state.count}`);
  });

  // Idempotent: upserting the same name on every activation is the intended
  // pattern for "this schedule should exist while the extension is active".
  await api.schedules.upsert("daily-report", {
    type: "periodic",
    schedule: "0 9 * * *",
    timezone: "Asia/Taipei",
    callback: "daily-report",
  });

  api.log("scheduled-counter ready");
}
