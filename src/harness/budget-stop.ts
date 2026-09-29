import type { BudgetStopReport, ToolTiming } from "./types.js";

const SLOWEST_STEPS_SHOWN = 3;
const SLOW_STEP_MS = 5_000;

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function describeStep(step: ToolTiming): string {
  return `${step.label} (${step.toolName})`;
}

function summaryLine(report: BudgetStopReport): string {
  const tools = [...report.completed, ...report.running];
  const ran = `Ran ${formatDuration(report.durationMs)}: ${report.llmCalls} model calls`;
  if (tools.length === 0) return `${ran}, no tool calls.`;
  const failed = report.completed.filter((step) => step.isError).length;
  const failedNote = failed > 0 ? ` (${failed} failed)` : "";
  const toolMs = tools.reduce((total, step) => total + step.durationMs, 0);
  return `${ran}, ${tools.length} tool calls${failedNote} that took ${formatDuration(toolMs)} in total.`;
}

export function formatBudgetStop(report: BudgetStopReport): string {
  const lines = [`Stopped: run budget exceeded (${report.reason})`, summaryLine(report)];
  const slowest = report.completed
    .filter((step) => step.durationMs >= SLOW_STEP_MS)
    .toSorted((left, right) => right.durationMs - left.durationMs)
    .slice(0, SLOWEST_STEPS_SHOWN);
  if (slowest.length > 0) {
    lines.push(
      "Slowest steps:",
      ...slowest.map(
        (step) =>
          `• ${describeStep(step)}: ${formatDuration(step.durationMs)}${step.isError ? ", failed" : ""}`,
      ),
    );
  }
  for (const step of report.running) {
    lines.push(
      `Still running when stopped: ${describeStep(step)}, ${formatDuration(step.durationMs)}`,
    );
  }
  return lines.join("\n");
}
