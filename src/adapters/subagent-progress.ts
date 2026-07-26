import type {
  SubagentProgressNode,
  SubagentProgressSnapshot,
  SubagentProgressStatus,
} from "../adapter.js";

const STATUS_MARKER = {
  pending: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
  cancelled: "■",
  timeout: "◷",
  budget_exceeded: "!",
  invalid_output: "✗",
  skipped: "⊘",
} satisfies Record<SubagentProgressStatus, string>;

const STATUS_LABEL = {
  pending: "Waiting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timeout: "Timed out",
  budget_exceeded: "Budget exceeded",
  invalid_output: "Invalid output",
  skipped: "Skipped",
} satisfies Record<SubagentProgressStatus, string>;

/**
 * Fold concurrent or successive subagent fan-outs into the single snapshot the
 * dashboard renders. A run can call the subagent tool more than once; picking
 * one snapshot would drop the others' cost and status, and alternating between
 * them makes the live view flicker. Node ids are namespaced by source because
 * each fan-out numbers its own nodes from zero.
 */
export function mergeSubagentProgress(
  snapshots: readonly SubagentProgressSnapshot[],
): SubagentProgressSnapshot | undefined {
  if (snapshots.length === 0) return undefined;
  if (snapshots.length === 1) return snapshots[0];
  const nodes = snapshots.flatMap((snapshot, index) =>
    snapshot.nodes.map((node) => ({ ...node, id: `${index}:${node.id}` })),
  );
  const mode = snapshots.some((snapshot) => snapshot.mode === "dag")
    ? "dag"
    : nodes.length > 1
      ? "parallel"
      : "single";
  return { mode, nodes };
}

function settledCount(snapshot: SubagentProgressSnapshot): number {
  return snapshot.nodes.filter((node) => node.status !== "pending" && node.status !== "running")
    .length;
}

function modeLabel(snapshot: SubagentProgressSnapshot): string {
  if (snapshot.mode === "dag") return "DAG";
  if (snapshot.mode === "parallel") return "Parallel";
  return "Run";
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()<>#+\-.!|~])/g, "\\$1");
}

function escapeSlackMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([*_`])/g, "\\$1");
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function summaryText(snapshot: SubagentProgressSnapshot): string {
  const totals = snapshot.nodes.reduce(
    (sum, node) => ({
      turns: sum.turns + (node.turns ?? 0),
      toolCalls: sum.toolCalls + (node.toolCalls ?? 0),
      tokens: sum.tokens + (node.tokens ?? 0),
      costUsd: sum.costUsd + (node.costUsd ?? 0),
    }),
    { turns: 0, toolCalls: 0, tokens: 0, costUsd: 0 },
  );
  return [
    totals.turns > 0 ? `${totals.turns} LLM turns` : undefined,
    totals.toolCalls > 0 ? `${totals.toolCalls} tool calls` : undefined,
    totals.tokens > 0 ? `${compactNumber(totals.tokens)} tokens` : undefined,
    totals.costUsd > 0 ? `$${totals.costUsd.toFixed(4)}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

function headerText(snapshot: SubagentProgressSnapshot): string {
  const base = `Subagents · ${settledCount(snapshot)}/${snapshot.nodes.length} · ${modeLabel(snapshot)}`;
  const summary = summaryText(snapshot);
  return summary ? `${base} · ${summary}` : base;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function detailText(node: SubagentProgressNode): string {
  const toolBreakdown = node.toolCallCounts
    ? Object.entries(node.toolCallCounts)
        .map(([name, count]) => `${name} ×${count}`)
        .join(" · ")
    : undefined;
  const metrics = [
    node.turns !== undefined ? countLabel(node.turns, "LLM turn") : undefined,
    node.toolCalls !== undefined ? countLabel(node.toolCalls, "tool call") : undefined,
    toolBreakdown,
    node.tokens !== undefined ? `${compactNumber(node.tokens)} tokens` : undefined,
    node.costUsd !== undefined ? `$${node.costUsd.toFixed(4)}` : undefined,
    node.durationMs !== undefined ? `${(node.durationMs / 1000).toFixed(1)}s` : undefined,
  ].filter(Boolean);
  const reason = node.cleanupPending ? "Cleanup pending; usage is provisional" : node.reason;
  // Profile leads the line: when a node reports no tool calls, the profile is
  // what says whether that was the plan or a bad pick.
  return [STATUS_LABEL[node.status], node.profile, ...metrics, reason].filter(Boolean).join(" · ");
}

function nodeRows(node: SubagentProgressNode, escapeLabel = (label: string) => label): string[] {
  return [`${STATUS_MARKER[node.status]} ${escapeLabel(node.label)}`, `└ ${detailText(node)}`];
}

export function formatSubagentProgressMarkdown(snapshot: SubagentProgressSnapshot): string {
  const header = `**${headerText(snapshot)}**`;
  return [header, ...snapshot.nodes.flatMap((node) => nodeRows(node, escapeMarkdown))].join("\n");
}

export function formatSubagentProgressSlack(snapshot: SubagentProgressSnapshot): string {
  const header = `*${headerText(snapshot)}*`;
  const rows = snapshot.nodes.flatMap((node) => [
    `${STATUS_MARKER[node.status]} *${escapeSlackMrkdwn(node.label)}*`,
    `└ ${escapeSlackMrkdwn(detailText(node))}`,
  ]);
  return [header, ...rows].join("\n");
}

export function formatSubagentProgressTelegram(snapshot: SubagentProgressSnapshot): string {
  const header = `<b>${headerText(snapshot)}</b>`;
  return [header, ...snapshot.nodes.flatMap((node) => nodeRows(node))].join("\n");
}
