import { describe, expect, test } from "vitest";
import {
  boundSubagentProgressNode,
  MAX_SUBAGENT_LABEL_CHARS,
  mergeSubagentProgress,
  parseSubagentProgressSnapshot,
  renderSubagentDashboard,
  settleSubagentProgress,
} from "../subagent-progress.js";
import type { SubagentProgressSnapshot } from "../types.js";

function snapshot(overrides?: Partial<SubagentProgressSnapshot>): SubagentProgressSnapshot {
  return {
    mode: "parallel",
    nodes: [
      { id: "0", label: "first", status: "completed", turns: 2, costUsd: 0.01 },
      { id: "1", label: "second", status: "running" },
    ],
    ...overrides,
  };
}

describe("parseSubagentProgressSnapshot", () => {
  test("round-trips a producer-constructed snapshot unchanged", () => {
    const source = snapshot();
    expect(parseSubagentProgressSnapshot(JSON.parse(JSON.stringify(source)))).toEqual(source);
  });

  test("rejects the whole candidate when one node is malformed", () => {
    const source = snapshot();
    const tampered = {
      ...source,
      nodes: [...source.nodes, { id: "2", label: "bad", status: "exploded" }],
    };
    expect(parseSubagentProgressSnapshot(tampered)).toBeUndefined();
  });

  test("rejects non-snapshot payloads", () => {
    expect(parseSubagentProgressSnapshot(undefined)).toBeUndefined();
    expect(parseSubagentProgressSnapshot("progress")).toBeUndefined();
    expect(parseSubagentProgressSnapshot({ mode: "unknown", nodes: [] })).toBeUndefined();
    expect(parseSubagentProgressSnapshot({ mode: "single" })).toBeUndefined();
  });

  test("applies the same display bounds as construction", () => {
    const parsed = parseSubagentProgressSnapshot({
      mode: "single",
      nodes: [
        {
          id: "0",
          label: "x".repeat(200),
          status: "failed",
          profile: "p".repeat(200),
          reason: "r".repeat(500),
        },
      ],
    });
    expect(parsed?.nodes[0].label).toHaveLength(MAX_SUBAGENT_LABEL_CHARS);
    expect(parsed?.nodes[0].label?.endsWith("…")).toBe(true);
    expect(parsed?.nodes[0].profile).toHaveLength(64);
    expect(parsed?.nodes[0].reason).toHaveLength(240);
  });
});

describe("boundSubagentProgressNode", () => {
  test("clamps label, profile and reason; leaves metrics alone", () => {
    const bounded = boundSubagentProgressNode({
      id: "0",
      label: "L".repeat(150),
      status: "completed",
      profile: "P".repeat(100),
      reason: "R".repeat(300),
      turns: 7,
    });
    expect(bounded.label).toBe(`${"L".repeat(MAX_SUBAGENT_LABEL_CHARS - 1)}…`);
    expect(bounded.profile).toBe("P".repeat(64));
    expect(bounded.reason).toBe("R".repeat(240));
    expect(bounded.turns).toBe(7);
  });

  test("leaves a label at the bound untouched — no ellipsis without truncation", () => {
    const exact = "E".repeat(MAX_SUBAGENT_LABEL_CHARS);
    expect(boundSubagentProgressNode({ id: "0", label: exact, status: "pending" }).label).toBe(
      exact,
    );
  });
});

describe("settleSubagentProgress", () => {
  test("settles pending and running nodes to the tool outcome, keeping fields", () => {
    const settled = settleSubagentProgress(
      {
        mode: "dag",
        nodes: [
          { id: "a", label: "done", status: "completed", turns: 3, profile: "explorer" },
          { id: "b", label: "live", status: "running", profile: "worker" },
          { id: "c", label: "queued", status: "pending" },
        ],
      },
      false,
    );
    expect(settled.nodes.map((node) => node.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(settled.nodes[0].turns).toBe(3);
    expect(settled.nodes[1].profile).toBe("worker");
  });

  test("marks unsettled nodes failed when the tool call errored", () => {
    const settled = settleSubagentProgress(snapshot(), true);
    expect(settled.nodes[1].status).toBe("failed");
    expect(settled.nodes[0].status).toBe("completed");
  });
});

describe("mergeSubagentProgress", () => {
  test("returns the single snapshot untouched", () => {
    const only = snapshot();
    expect(mergeSubagentProgress([only])).toBe(only);
    expect(mergeSubagentProgress([])).toBeUndefined();
  });

  test("namespaces node ids by source so fan-outs cannot collide", () => {
    const merged = mergeSubagentProgress([
      { mode: "single", nodes: [{ id: "0", label: "a", status: "completed" }] },
      { mode: "single", nodes: [{ id: "0", label: "b", status: "running" }] },
    ]);
    expect(merged?.nodes.map((node) => node.id)).toEqual(["0:0", "1:0"]);
    expect(merged?.mode).toBe("parallel");
  });

  test("promotes the merged mode to dag when any source is a dag", () => {
    const merged = mergeSubagentProgress([
      { mode: "dag", nodes: [{ id: "a", label: "a", status: "completed" }] },
      { mode: "single", nodes: [{ id: "0", label: "b", status: "running" }] },
    ]);
    expect(merged?.mode).toBe("dag");
  });
});

describe("renderSubagentDashboard", () => {
  test("renders response source Markdown with escaped labels and raw details", () => {
    const rendered = renderSubagentDashboard({
      mode: "single",
      nodes: [
        {
          id: "0",
          label: "Explore <auth>",
          status: "completed",
          profile: "explorer",
          turns: 2,
          reason: "all good",
        },
      ],
    });
    expect(rendered).toContain("**Subagents · 1/1 · Run · 2 LLM turns**");
    expect(rendered).toContain("✓ Explore \\<auth\\>");
    expect(rendered).toContain("└ Completed · explorer · 2 LLM turns · all good");
  });

  /**
   * A node reports its metrics on the way out, so for the whole of a long step
   * the row would otherwise read "Running · profile" and never change — which
   * is indistinguishable from a hang, and was reported as one.
   */
  test("a running node shows what it is doing", () => {
    const rendered = renderSubagentDashboard({
      mode: "dag",
      nodes: [
        {
          id: "0",
          label: "Forensics",
          status: "running",
          profile: "analysis-only",
          activity: "bash: count the samples",
        },
      ],
    });
    expect(rendered).toContain("● Forensics");
    expect(rendered).toContain("└ Running · analysis-only · bash: count the samples");
  });

  test("activity is dropped once the node settles", () => {
    // Stale by definition, and the metrics that replace it are the real story.
    const rendered = renderSubagentDashboard({
      mode: "dag",
      nodes: [
        {
          id: "0",
          label: "Forensics",
          status: "completed",
          activity: "writing · 900 chars",
          turns: 1,
        },
      ],
    });
    expect(rendered).not.toContain("writing");
    expect(rendered).toContain("└ Completed · 1 LLM turn");
  });
});
