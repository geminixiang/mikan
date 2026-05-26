import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createEventTool, HostEventStore, type EventPayload } from "../src/tools/event.js";

describe("createEventTool", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function makeWorkspace(): string {
    const dir = mkdtempSync(join(tmpdir(), "mikan-event-tool-test-"));
    tempDirs.push(dir);
    return dir;
  }

  function createWorkspaceEventTool(workspaceDir: string) {
    return createEventTool(HostEventStore.fromWorkspaceDir(workspaceDir));
  }

  test("writes top-level Slack event payload without threadTs", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });

    const result = await tool.execute("call-1", {
      label: "deploy",
      type: "immediate",
      text: "Check deployment status",
      filenamePrefix: " Deploy / Prod ",
    });

    const eventsDir = join(workspaceDir, "events");
    const files = readdirSync(eventsDir);
    expect(files).toEqual(["deploy-prod-1700000000000.json"]);
    expect(JSON.parse(readFileSync(join(eventsDir, files[0]), "utf-8"))).toEqual({
      type: "immediate",
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
      text: "Check deployment status",
    });
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain(
      "Queued immediate event deploy-prod-1700000000000.json",
    );
  });

  test("writes through the injected control-plane event store", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000002);
    const writes: Array<{ filename: string; payload: EventPayload }> = [];
    const { tool, setEventContext } = createEventTool({
      async write(filename, payload) {
        writes.push({ filename, payload });
        return { path: `/control/events/${filename}`, size: 123 };
      },
    });
    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });

    await tool.execute("call-1", {
      label: "deploy",
      type: "immediate",
      text: "Check deployment status",
      filenamePrefix: "deploy",
    });

    expect(writes).toEqual([
      {
        filename: "deploy-1700000000002.json",
        payload: {
          type: "immediate",
          platform: "slack",
          conversationId: "C123",
          conversationKind: "shared",
          userId: "U123",
          text: "Check deployment status",
        },
      },
    ]);
  });

  test("surfaces control-plane event store write failures", async () => {
    const { tool, setEventContext } = createEventTool({
      async write() {
        throw new Error("control plane unavailable");
      },
    });
    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });

    await expect(
      tool.execute("call-1", {
        label: "deploy",
        type: "immediate",
        text: "Check deployment status",
      }),
    ).rejects.toThrow("control plane unavailable");
  });

  test("writes immediate event payload without thread state even when scheduled from a thread", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000001);
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });

    await tool.execute("call-1", {
      label: "deploy",
      type: "immediate",
      text: "Check deployment status",
    });

    const eventsDir = join(workspaceDir, "events");
    const files = readdirSync(eventsDir);
    expect(files).toEqual(["immediate-1700000000001.json"]);
    expect(JSON.parse(readFileSync(join(eventsDir, files[0]), "utf-8"))).toEqual({
      type: "immediate",
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
      text: "Check deployment status",
    });
  });

  test("requires event context before execution", async () => {
    const workspaceDir = makeWorkspace();
    const { tool } = createWorkspaceEventTool(workspaceDir);

    await expect(
      tool.execute("call-1", {
        label: "deploy",
        type: "immediate",
        text: "Check deployment status",
      }),
    ).rejects.toThrow("Event context not configured");
  });

  test("one-shot event strips thread state even when set in context", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000200);
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });

    await tool.execute("call-1", {
      label: "dentist",
      type: "one-shot",
      text: "Dentist tomorrow",
      at: "2025-12-15T09:00:00+01:00",
    });

    const eventsDir = join(workspaceDir, "events");
    const files = readdirSync(eventsDir);
    expect(JSON.parse(readFileSync(join(eventsDir, files[0]), "utf-8"))).toEqual({
      type: "one-shot",
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
      text: "Dentist tomorrow",
      at: "2025-12-15T09:00:00+01:00",
    });
  });

  test("periodic event strips thread state when in a thread", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000300);
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });

    await tool.execute("call-1", {
      label: "inbox",
      type: "periodic",
      text: "Check inbox",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
    });

    const eventsDir = join(workspaceDir, "events");
    const files = readdirSync(eventsDir);
    expect(JSON.parse(readFileSync(join(eventsDir, files[0]), "utf-8"))).toEqual({
      type: "periodic",
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
      text: "Check inbox",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
    });
  });

  test("one-shot events require at", async () => {
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });

    await expect(
      tool.execute("call-1", {
        label: "dentist",
        type: "one-shot",
        text: "Reminder",
      }),
    ).rejects.toThrow("`at` is required for one-shot events");
  });

  test("one-shot events reject invalid timestamps", async () => {
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "slack",
      conversationId: "D123",
      conversationKind: "direct",
      userId: "U123",
    });

    await expect(
      tool.execute("call-1", {
        label: "reminder",
        type: "one-shot",
        text: "Open x.com",
        at: "not-a-timestamp",
      }),
    ).rejects.toThrow("`at` must be a valid ISO 8601 timestamp with UTC offset");
  });

  test("one-shot events reject past timestamps", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-14T11:00:50.000Z"));
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "slack",
      conversationId: "D123",
      conversationKind: "direct",
      userId: "U123",
    });

    await expect(
      tool.execute("call-1", {
        label: "reminder",
        type: "one-shot",
        text: "Open x.com",
        at: "2026-05-14T11:01:10+08:00",
      }),
    ).rejects.toThrow(/`at` must be in the future/);
  });

  test("periodic events require schedule and timezone", async () => {
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "discord",
      conversationId: "D123",
      conversationKind: "direct",
      userId: "U456",
    });

    await expect(
      tool.execute("call-1", {
        label: "inbox",
        type: "periodic",
        text: "Check inbox",
        timezone: "Asia/Taipei",
      }),
    ).rejects.toThrow("`schedule` is required for periodic events");

    await expect(
      tool.execute("call-2", {
        label: "inbox",
        type: "periodic",
        text: "Check inbox",
        schedule: "0 9 * * 1-5",
      }),
    ).rejects.toThrow("`timezone` is required for periodic events");
  });

  test("writes periodic event payload with context", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000100);
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "telegram",
      conversationId: "999",
      conversationKind: "direct",
      userId: "U789",
    });

    const result = await tool.execute("call-1", {
      label: "inbox",
      type: "periodic",
      text: "Check inbox",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
    });

    const eventsDir = join(workspaceDir, "events");
    const files = readdirSync(eventsDir);
    expect(files).toEqual(["periodic-1700000000100.json"]);
    expect(JSON.parse(readFileSync(join(eventsDir, files[0]), "utf-8"))).toEqual({
      type: "periodic",
      platform: "telegram",
      conversationId: "999",
      conversationKind: "direct",
      userId: "U789",
      text: "Check inbox",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
    });
    expect(result.content[0]?.text).toContain(
      "Scheduled periodic event periodic-1700000000100.json",
    );
  });
});
