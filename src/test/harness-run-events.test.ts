import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { RunEventHub, toRunEvent } from "../harness/run-events.js";
import type { RunEvent } from "../harness/types.js";
import { createOfficeAddress } from "../office/index.js";
import { JEV_TOOL } from "../harness/tools/jev.js";

const subagentSnapshot = {
  mode: "single",
  nodes: [{ id: "node-1", label: "Inspect code", status: "running" }],
};

describe("toRunEvent", () => {
  test("names a started tool by its trimmed label, falling back to the tool name", () => {
    expect(
      toRunEvent({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { label: "  List files  ", command: "ls" },
      }),
    ).toEqual({
      type: "tool_started",
      toolCallId: "t1",
      toolName: "bash",
      label: "List files",
      args: { label: "  List files  ", command: "ls" },
    });
    expect(
      toRunEvent({ type: "tool_execution_start", toolCallId: "t2", toolName: "read", args: {} }),
    ).toMatchObject({ label: "read" });
  });

  test("prefixes Jev labels with the tool name", () => {
    expect(
      toRunEvent({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: JEV_TOOL,
        args: { label: "Check memory" },
      }),
    ).toMatchObject({ label: `${JEV_TOOL} · Check memory` });
  });

  test("reports subagent progress and ignores other partial results", () => {
    expect(
      toRunEvent({
        type: "tool_execution_update",
        toolCallId: "s1",
        toolName: "subagent",
        details: { progress: subagentSnapshot },
      }),
    ).toMatchObject({
      type: "subagent_progress",
      toolCallId: "s1",
      snapshot: { mode: "single", nodes: [{ id: "node-1", status: "running" }] },
    });
    expect(
      toRunEvent({
        type: "tool_execution_update",
        toolCallId: "b1",
        toolName: "bash",
        details: { other: true },
      }),
    ).toBeUndefined();
  });

  test("reports a finished tool with its text result", () => {
    expect(
      toRunEvent({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        isError: true,
        result: { content: [{ type: "text", text: "boom" }] },
      }),
    ).toEqual({
      type: "tool_ended",
      toolCallId: "t1",
      toolName: "bash",
      isError: true,
      resultText: "boom",
    });
  });

  test("reports assistant text deltas and drops empty ones", () => {
    expect(toRunEvent({ type: "text_delta", delta: "hi" })).toEqual({
      type: "assistant_delta",
      delta: "hi",
    });
    expect(toRunEvent({ type: "text_delta", delta: "" })).toBeUndefined();
  });

  test("reports a finished assistant message with its thinking, text, and whether it calls tools", () => {
    const message = fauxAssistantMessage([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      { type: "toolCall", id: "t1", name: "bash", arguments: {} },
    ]);
    expect(toRunEvent({ type: "message_end", message })).toEqual({
      type: "assistant_message",
      thinking: ["plan"],
      text: "first\nsecond",
      callsTools: true,
    });
    expect(
      toRunEvent({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
      }),
    ).toBeUndefined();
  });

  test("reports compaction start, retries, and budget stops", () => {
    expect(toRunEvent({ type: "compaction_start", reason: "threshold" })).toEqual({
      type: "compaction_started",
    });
    expect(
      toRunEvent({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: "overloaded",
      }),
    ).toEqual({ type: "retry_started", attempt: 2, maxAttempts: 3 });
    expect(
      toRunEvent({
        type: "budget_exceeded",
        reason: "tool loop: bash",
        tokens: 1,
        costUsd: 0,
        llmCalls: 1,
        durationMs: 1,
      }),
    ).toEqual({ type: "budget_exceeded", reason: "tool loop: bash", llmCalls: 1, durationMs: 1 });
  });
});

describe("RunEventHub", () => {
  const office = createOfficeAddress("slack", "C1");

  test("delivers events only to subscribers of the same office session", () => {
    const hub = new RunEventHub();
    const sameSession: RunEvent[] = [];
    const otherSession: RunEvent[] = [];
    const otherOffice: RunEvent[] = [];
    hub.subscribe(office, "C1", (event) => sameSession.push(event));
    hub.subscribe(office, "C1:1000.1", (event) => otherSession.push(event));
    hub.subscribe(createOfficeAddress("telegram", "C1"), "C1", (event) => otherOffice.push(event));

    hub.publish(office, "C1", { type: "assistant_delta", delta: "hi" });

    expect(sameSession).toEqual([{ type: "assistant_delta", delta: "hi" }]);
    expect(otherSession).toEqual([]);
    expect(otherOffice).toEqual([]);
  });

  test("stops delivering after unsubscribe", () => {
    const hub = new RunEventHub();
    const seen: RunEvent[] = [];
    const unsubscribe = hub.subscribe(office, "C1", (event) => seen.push(event));

    unsubscribe();
    hub.publish(office, "C1", { type: "compaction_started" });

    expect(seen).toEqual([]);
  });

  test("keeps delivering to other subscribers when one listener throws", () => {
    const hub = new RunEventHub();
    const seen: RunEvent[] = [];
    hub.subscribe(office, "C1", () => {
      throw new Error("viewer went away");
    });
    hub.subscribe(office, "C1", (event) => seen.push(event));

    hub.publish(office, "C1", { type: "compaction_started" });

    expect(seen).toEqual([{ type: "compaction_started" }]);
  });
});
