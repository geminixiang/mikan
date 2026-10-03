import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openSessionAt } from "./session-context.js";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { ToolLoopGuard } from "../harness/loop-guard.js";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import type { HarnessEvent } from "../harness/types.js";
import { SessionStore } from "../sessions/session-store.js";

describe("ToolLoopGuard", () => {
  test("escalates consecutive identical calls from notice to block to stop", () => {
    const guard = new ToolLoopGuard();
    const kinds = Array.from({ length: 10 }, () => guard.observe("read", { path: "a.txt" }).kind);
    expect(kinds).toEqual([
      "allow",
      "allow",
      "notice",
      "notice",
      "block",
      "block",
      "block",
      "block",
      "block",
      "stop",
    ]);
  });

  test("ignores the presentation label and object key order", () => {
    const guard = new ToolLoopGuard();
    guard.observe("bash", { command: "ls", timeout: 5, label: "first" });
    guard.observe("bash", { timeout: 5, command: "ls", label: "second" });
    expect(guard.observe("bash", { label: "third", command: "ls", timeout: 5 }).kind).toBe(
      "notice",
    );
  });

  test("a different call resets the identical run", () => {
    const guard = new ToolLoopGuard();
    guard.observe("read", { path: "a.txt" });
    guard.observe("read", { path: "a.txt" });
    guard.observe("read", { path: "b.txt" });
    expect(guard.observe("read", { path: "a.txt" }).kind).toBe("allow");
  });

  test("reports a repeating cycle once, then again only after it doubles", () => {
    const guard = new ToolLoopGuard();
    const kinds = Array.from({ length: 12 }, (_, index) =>
      index % 2 === 0
        ? guard.observe("read", { path: "a.txt" }).kind
        : guard.observe("bash", { command: "cat a.txt" }).kind,
    );
    expect(kinds.map((kind, index) => (kind === "notice" ? index + 1 : 0)).filter(Boolean)).toEqual(
      [6, 12],
    );
  });

  test("distinct work never triggers", () => {
    const guard = new ToolLoopGuard();
    const kinds = Array.from(
      { length: 20 },
      (_, index) => guard.observe("read", { path: `file-${index}.txt` }).kind,
    );
    expect(new Set(kinds)).toEqual(new Set(["allow"]));
  });
});

describe("MikanAgentSession tool loop guard", () => {
  let dir: string;
  const stores: SessionStore[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mikan-loop-guard-"));
  });
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  test("warns, blocks, and finally stops a run that repeats one identical call", async () => {
    const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
    const faux = fauxProvider();
    (models.models as MutableModels).setProvider(faux.provider);
    let executions = 0;
    const tool: AgentTool = {
      name: "probe",
      label: "probe",
      description: "Probe a path",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "unchanged" }], details: {} };
      },
    };
    const store = await openSessionAt(join(dir, "session.jsonl"));
    stores.push(store);
    const session = new MikanAgentSession({
      model: faux.getModel() as Model<Api>,
      models,
      sessionStore: store,
      tools: [tool],
      thinkingLevel: "off",
      systemPrompt: "prompt",
      settings: { compaction: { enabled: false } },
    });
    faux.setResponses([
      ...Array.from({ length: 10 }, () =>
        fauxAssistantMessage(fauxToolCall("probe", { path: "status.txt" }), {
          stopReason: "toolUse",
        }),
      ),
      fauxAssistantMessage("unreachable"),
    ]);
    const events: HarnessEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.prompt("check the status");

    expect(executions).toBe(4);
    const results = events.flatMap((event) =>
      event.type === "tool_execution_end" ? [JSON.stringify(event.result)] : [],
    );
    expect(results[0]).not.toContain("identical arguments");
    expect(results[2]).toContain("identical arguments");
    expect(results[4]).toContain("was not executed");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "budget_exceeded",
        reason: expect.stringContaining("tool loop"),
      }),
    );
    expect(session.getLastRunStats().budgetExceededReason).toContain("tool loop");
  });
});
