import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import type { AgentAuditEventInput, AgentAuditRun } from "../audit/index.js";
import { MikanAgentSession, MikanModels, SessionStore } from "../harness/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mikan-harness-audit-"));
  dirs.push(dir);
  return dir;
}

class MemoryAuditRun implements AgentAuditRun {
  readonly runId = "run-1";
  readonly runKind = "interactive" as const;
  readonly events: AgentAuditEventInput[] = [];

  record(event: AgentAuditEventInput): void {
    this.events.push(event);
  }

  child(): AgentAuditRun {
    return new MemoryAuditRun();
  }
}

function setup() {
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  const model = models.resolve("faux", "faux-1");
  return { dir, models, faux, model };
}

describe("MikanAgentSession audit reduction", () => {
  test("records logical model and tool lifecycle without prompt or tool payloads", async () => {
    const { dir, models, faux, model } = setup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("probe", { secret: "DO_NOT_STORE" })),
      fauxAssistantMessage("DO_NOT_STORE_RESPONSE"),
    ]);
    const auditRun = new MemoryAuditRun();
    const session = new MikanAgentSession({
      systemPrompt: "DO_NOT_STORE_SYSTEM",
      model,
      thinkingLevel: "off",
      tools: [
        {
          name: "probe",
          label: "Probe",
          description: "test tool",
          parameters: Type.Object({ secret: Type.String() }),
          execute: async () => ({
            content: [{ type: "text" as const, text: "DO_NOT_STORE_TOOL_RESULT" }],
            details: { secret: "DO_NOT_STORE_DETAIL" },
          }),
        },
      ],
      models,
      sessionStore: await SessionStore.create(join(dir, "session.jsonl"), dir),
    });

    await session.prompt("DO_NOT_STORE_PROMPT", { auditRun });

    expect(auditRun.events.map((event) => event.type)).toEqual([
      "turn_started",
      "model_request_started",
      "model_request_completed",
      "tool_started",
      "tool_completed",
      "turn_completed",
      "turn_started",
      "model_request_started",
      "model_request_completed",
      "turn_completed",
    ]);
    const serialized = JSON.stringify(auditRun.events);
    expect(serialized).not.toContain("DO_NOT_STORE");
    expect(auditRun.events.filter((event) => event.type === "model_request_started")).toHaveLength(
      2,
    );
    expect(auditRun.events.find((event) => event.type === "tool_started")).toMatchObject({
      toolName: "probe",
      status: "running",
    });
  });

  test("does not persist message_update snapshots", async () => {
    const { dir, models, faux, model } = setup();
    faux.setResponses([fauxAssistantMessage("a".repeat(50_000))]);
    const auditRun = new MemoryAuditRun();
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: await SessionStore.create(join(dir, "session.jsonl"), dir),
    });

    await session.prompt("stream", { auditRun });

    expect(auditRun.events).toHaveLength(4);
    expect(JSON.stringify(auditRun.events).length).toBeLessThan(4_000);
  });
});
