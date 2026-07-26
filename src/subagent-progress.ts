import type {
  SubagentProgressNode,
  SubagentProgressSnapshot,
  SubagentProgressStatus,
} from "./types.js";

/**
 * The subagent progress snapshot module. The snapshot crosses an untyped
 * transport (tool update `details`) between the subagent tool and the harness,
 * so producer construction, consumer parsing, display bounds, the
 * status→presentation tables, settling, merging, and the response-source
 * rendering all live here — one module owns the shape end to end. Adapters
 * whose pipeline is not response-source Markdown (Telegram HTML) convert via
 * the exported header/row text primitives instead of restating content.
 */

/** Longest label the dashboard renders; longer ones are clamped, never rejected. */
export const MAX_SUBAGENT_LABEL_CHARS = 100;
const MAX_PROFILE_CHARS = 64;
const MAX_REASON_CHARS = 240;

const SUBAGENT_STATUS_MARKER = {
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

const SUBAGENT_STATUS_LABEL = {
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
 * Derived from the marker table, which `satisfies` keeps exhaustive: a new
 * terminal status is a compile error there, and this runtime set follows —
 * the validator can never silently drop a status the tables know about.
 */
const VALID_STATUSES: ReadonlySet<string> = new Set(Object.keys(SUBAGENT_STATUS_MARKER));

/** Clamp a label to the display bound, ending a truncation visibly with `…`. */
export function clampSubagentLabel(label: string): string {
  if (label.length <= MAX_SUBAGENT_LABEL_CHARS) return label;
  return `${label.slice(0, MAX_SUBAGENT_LABEL_CHARS - 1)}…`;
}

/** The display bounds, applied once at construction and again on parse. */
export function boundSubagentProgressNode(node: SubagentProgressNode): SubagentProgressNode {
  return {
    ...node,
    label: clampSubagentLabel(node.label),
    ...(node.profile !== undefined ? { profile: node.profile.slice(0, MAX_PROFILE_CHARS) } : {}),
    ...(node.reason !== undefined ? { reason: node.reason.slice(0, MAX_REASON_CHARS) } : {}),
  };
}

function parseNode(value: unknown): SubagentProgressNode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<keyof SubagentProgressNode, unknown>;
  if (
    typeof item.id !== "string" ||
    typeof item.label !== "string" ||
    typeof item.status !== "string" ||
    !VALID_STATUSES.has(item.status)
  ) {
    return undefined;
  }
  return boundSubagentProgressNode({
    id: item.id,
    label: item.label,
    status: item.status as SubagentProgressStatus,
    ...(typeof item.profile === "string" ? { profile: item.profile } : {}),
    ...(typeof item.turns === "number" ? { turns: item.turns } : {}),
    ...(typeof item.toolCalls === "number" ? { toolCalls: item.toolCalls } : {}),
    ...(item.toolCallCounts && typeof item.toolCallCounts === "object"
      ? {
          toolCallCounts: Object.fromEntries(
            Object.entries(item.toolCallCounts).filter(
              (entry): entry is [string, number] => typeof entry[1] === "number",
            ),
          ),
        }
      : {}),
    ...(typeof item.tokens === "number" ? { tokens: item.tokens } : {}),
    ...(typeof item.costUsd === "number" ? { costUsd: item.costUsd } : {}),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
    ...(item.cleanupPending === true ? { cleanupPending: true } : {}),
  });
}

/**
 * Parse a snapshot back off the untyped transport. All-or-nothing: one
 * malformed node means the payload is not ours (any tool can put anything in
 * `details`), so the whole candidate is rejected rather than partially shown.
 */
export function parseSubagentProgressSnapshot(
  value: unknown,
): SubagentProgressSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { mode?: unknown; nodes?: unknown };
  if (
    (candidate.mode !== "single" && candidate.mode !== "parallel" && candidate.mode !== "dag") ||
    !Array.isArray(candidate.nodes)
  ) {
    return undefined;
  }
  const nodes: SubagentProgressNode[] = [];
  for (const node of candidate.nodes) {
    const parsed = parseNode(node);
    if (!parsed) return undefined;
    nodes.push(parsed);
  }
  return { mode: candidate.mode, nodes };
}

/**
 * Project a live snapshot to its end-of-tool state: nodes still pending or
 * running settle to the tool call's outcome. Metrics spread through
 * unchanged — an unsettled node never reported any.
 */
export function settleSubagentProgress(
  snapshot: SubagentProgressSnapshot,
  isError: boolean,
): SubagentProgressSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) =>
      node.status !== "running" && node.status !== "pending"
        ? node
        : { ...node, status: isError ? "failed" : "completed" },
    ),
  };
}

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

// ---------------------------------------------------------------------------
// Dashboard text
// ---------------------------------------------------------------------------

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

/** The dashboard's one-line summary header, unformatted. */
export function subagentDashboardHeader(snapshot: SubagentProgressSnapshot): string {
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
  return [SUBAGENT_STATUS_LABEL[node.status], node.profile, ...metrics, reason]
    .filter(Boolean)
    .join(" · ");
}

/** A node's marker+label row and detail row, unformatted. */
export function subagentDashboardNodeLines(node: SubagentProgressNode): string[] {
  return [`${SUBAGENT_STATUS_MARKER[node.status]} ${node.label}`, `└ ${detailText(node)}`];
}

/** The dashboard as response source Markdown; adapters own any conversion. */
export function renderSubagentDashboard(snapshot: SubagentProgressSnapshot): string {
  const header = `**${subagentDashboardHeader(snapshot)}**`;
  const rows = snapshot.nodes.flatMap((node) => [
    `${SUBAGENT_STATUS_MARKER[node.status]} ${escapeMarkdown(node.label)}`,
    `└ ${detailText(node)}`,
  ]);
  return [header, ...rows].join("\n");
}
