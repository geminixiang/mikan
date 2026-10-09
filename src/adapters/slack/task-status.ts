import type { Office } from "../../office/types.js";
import { parseSlackSessionKey } from "./session.js";
import { reportUserFacingError } from "../../observability/index.js";
import { SessionStore } from "../../sessions/session-store.js";
import type { TaskSessionState } from "../../sessions/types.js";
import type { TaskStatus, RunningSession } from "../../types.js";

export function isTaskStatusQuestion(text: string): boolean {
  return /^(好了嗎|完成了嗎|有進展嗎|現在做到哪了|進度如何|還要多久|還要多久啊|現在怎麼樣|怎麼樣了|how(?:'s| is) it going|are you done|any updates|status)[？?！!。\s]*$/i.test(
    text.trim(),
  );
}

export async function querySlackTasks(
  office: Office,
  channel: string,
  running: RunningSession[],
  sessionKey?: string,
): Promise<TaskStatus[]> {
  const activeByKey = new Map(
    running
      .filter((s) => s.address.platform === "slack" && s.address.conversationId === channel)
      .map((s) => [s.sessionKey, s]),
  );
  let tasks: TaskSessionState[];
  try {
    tasks = await SessionStore.listTasks(office, channel);
  } catch (error) {
    reportUserFacingError(error, {
      domain: "mikan",
      surface: "task_status",
      operation: "inspect_task_status",
      severity: "warning",
      platform: "slack",
      context: { conversationId: channel },
    });
    return [];
  }
  const observedAt = new Date().toISOString();
  return tasks
    .filter((task) => !sessionKey || task.sessionKey === sessionKey)
    .filter((task, index) => index < 10 || activeByKey.has(task.sessionKey))
    .flatMap((task) => {
      const ref = parseSlackSessionKey(task.sessionKey);
      if (ref.kind !== "thread") return [];
      return [observeTask(task, ref.threadTs, activeByKey.get(task.sessionKey), observedAt)];
    });
}

function observeTask(
  task: TaskSessionState,
  threadTs: string,
  active: RunningSession | undefined,
  observedAt: string,
): TaskStatus {
  const observation: TaskStatus = {
    sessionKey: task.sessionKey,
    threadTs,
    acknowledgement: task.acknowledgement ?? "",
    observedAt,
    status: "unknown",
  };
  const finishedThisRun =
    !task.open && task.result && (!active || task.result.endedAt >= active.startedAt);
  if (finishedThisRun && task.result) {
    observation.status = task.result.status;
    observation.endedAt = new Date(task.result.endedAt).toISOString();
  } else if (active) {
    observation.status = active.stopping ? "stopping" : "running";
    observation.currentTool = active.currentTool;
  } else if (!task.started) {
    observation.status = "queued";
  }
  return observation;
}

export function formatTaskStatus(tasks: TaskStatus[]): string {
  if (!tasks.length) return "找不到這個任務的狀態。";
  return tasks
    .map((task) => {
      switch (task.status) {
        case "running":
          return `還在處理${task.currentTool ? `，目前正在：${task.currentTool}` : ""}。目前無法可靠估計還要多久，結束後會通知你。`;
        case "completed":
          return "這一輪執行已結束。這是執行狀態，不代表結果訊息已成功送達；請查看任務對話串。";
        case "aborted":
          return "這一輪已停止，不會自行繼續。你可以補充新要求後再繼續。";
        case "failed":
          return "這一輪執行失敗。";
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
