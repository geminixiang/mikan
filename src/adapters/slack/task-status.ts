import { readTextFileIfExists } from "../../file-guards.js";
import { join } from "node:path";
import { resolveSlackSessionKey } from "./session.js";
import { getThreadSessionFile } from "../../sessions/store.js";
import { SessionStore } from "../../sessions/session-store.js";
import type { TaskStatus, RunningSession } from "../../types.js";

/** Narrow pure-status shortcut. Mixed instructions must still reach the agent. */
export function isTaskStatusQuestion(text: string): boolean {
  return /^(好了嗎|完成了嗎|有進展嗎|現在做到哪了|進度如何|還要多久|還要多久啊|現在怎麼樣|怎麼樣了|how(?:'s| is) it going|are you done|any updates|status)[？?！!。\s]*$/i.test(
    text.trim(),
  );
}

export function readTaskRoots(conversationDir: string): Map<string, string> {
  const raw = readTextFileIfExists(join(conversationDir, "log.jsonl")) ?? "";
  const roots = new Map<string, string>();
  for (const line of raw.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry.taskRoot === true && entry.isMessagingBot === true && typeof entry.ts === "string")
        roots.set(entry.ts, String(entry.text ?? ""));
    } catch {
      /* unrelated malformed log record */
    }
  }
  return roots;
}

export async function querySlackTasks(
  conversationDir: string,
  channel: string,
  running: RunningSession[],
  sessionKey?: string,
): Promise<TaskStatus[]> {
  const roots = readTaskRoots(conversationDir);
  const matching = [...roots]
    .toReversed()
    .filter(([root]) => !sessionKey || resolveSlackSessionKey(channel, root) === sessionKey);
  const activeKeys = new Set(
    running
      .filter((s) => s.address.platform === "slack" && s.address.conversationId === channel)
      .map((s) => s.sessionKey),
  );
  // Never hide active work behind the recent-completed history limit.
  const selected = matching.filter(
    ([root], index) => index < 10 || activeKeys.has(resolveSlackSessionKey(channel, root)),
  );
  return Promise.all(
    selected.map(async ([root, acknowledgement]) => {
      const key = resolveSlackSessionKey(channel, root);
      const active = running.find(
        (s) =>
          activeKeys.has(key) &&
          s.sessionKey === key &&
          s.address.platform === "slack" &&
          s.address.conversationId === channel,
      );
      const observation: TaskStatus = {
        sessionKey: key,
        threadTs: root,
        acknowledgement,
        observedAt: new Date().toISOString(),
        status: "unknown",
      };
      if (active) {
        observation.status = active.stopping ? "stopping" : "running";
        observation.currentTool = active.currentTool;
        return observation;
      }
      try {
        const state = await SessionStore.inspectExecution(
          getThreadSessionFile(conversationDir, key),
        );
        if (!state.open && state.result) {
          observation.status = state.result.status;
          observation.endedAt = new Date(state.result.endedAt).toISOString();
        }
      } catch {
        // No runtime or durable outcome: do not invent queued/completed state.
      }
      return observation;
    }),
  );
}

export function formatTaskStatus(tasks: TaskStatus[]): string {
  if (!tasks.length) return "找不到這個任務的狀態。";
  return tasks
    .map((task) => {
      switch (task.status) {
        case "running":
          return `還在處理${task.currentTool ? `，目前正在：${task.currentTool}` : ""}。目前無法可靠估計還要多久，結束後會通知你。`;
        case "completed":
          return "這一輪已結束，結果在這個對話串上方。";
        case "aborted":
          return "這一輪已停止，不會自行繼續。你可以補充新要求後再繼續。";
        case "failed":
          return "這一輪執行失敗，請查看上方的錯誤訊息。";
        case "queued":
          return "任務尚未開始執行。";
        case "declined":
          return "這一輪沒有執行。";
        case "stopping":
          return "正在停止，還在等待執行收尾。";
        default:
          return "目前無法確認任務狀態，不能判定已完成。";
      }
    })
    .join("\n\n");
}
