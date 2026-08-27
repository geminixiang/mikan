import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createEventTool, HostEventStore, type EventPayload } from "../tools/event.js";

function createWorkspaceEventTool(workspaceDir: string) {
  return createEventTool(HostEventStore.fromWorkspaceDir(workspaceDir));
}

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
      async list() {
        return [];
      },
      async read() {
        throw new Error("not implemented");
      },
      async update() {
        throw new Error("not implemented");
      },
      async delete() {
        return { deleted: true };
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
      async list() {
        return [];
      },
      async read() {
        throw new Error("not implemented");
      },
      async update() {
        throw new Error("not implemented");
      },
      async delete() {
        return { deleted: true };
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

  test("lists current conversation by default and all events when requested", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000003);
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });

    await tool.execute("call-1", {
      type: "immediate",
      text: "Visible in this conversation",
      filenamePrefix: "visible",
    });

    setEventContext({
      platform: "slack",
      conversationId: "C999",
      conversationKind: "shared",
      userId: "U123",
    });
    await tool.execute("call-2", {
      type: "immediate",
      text: "Visible only globally",
      filenamePrefix: "global",
    });

    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });
    const scopedResult = await tool.execute("call-3", { action: "list" });
    expect(scopedResult.content[0]?.text).toContain("visible-1700000000003.json");
    expect(scopedResult.content[0]?.text).not.toContain("Visible only globally");

    const allResult = await tool.execute("call-4", { action: "list", scope: "all" });
    expect(allResult.content[0]?.text).toContain("Visible in this conversation");
    expect(allResult.content[0]?.text).toContain("Visible only globally");
  });

  test("conversation scope excludes another platform's identically named office", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000003);
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "discord",
      conversationId: "900100",
      conversationKind: "shared",
      userId: "U123",
    });
    await tool.execute("call-1", {
      type: "immediate",
      text: "Discord office schedule",
      filenamePrefix: "discord-office",
    });

    setEventContext({
      platform: "telegram",
      conversationId: "900100",
      conversationKind: "shared",
      userId: "U123",
    });
    const scoped = await tool.execute("call-2", { action: "list" });
    expect(scoped.content[0]?.text).not.toContain("Discord office schedule");

    // The workspace scheduling bus stays fully visible on request.
    const all = await tool.execute("call-3", { action: "list", scope: "all" });
    expect(all.content[0]?.text).toContain("Discord office schedule");
  });

  test("supports list, read, update, and delete", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000003);
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });

    await tool.execute("call-1", {
      type: "immediate",
      text: "Check deployment status",
      filenamePrefix: "deploy",
    });

    const listResult = await tool.execute("call-2", { action: "list" });
    expect(listResult.content[0]?.text).toContain("deploy-1700000000003.json");

    const readResult = await tool.execute("call-3", {
      action: "read",
      filename: "deploy-1700000000003.json",
    });
    expect(readResult.content[0]?.text).toContain("Check deployment status");

    await tool.execute("call-4", {
      action: "update",
      filename: "deploy-1700000000003.json",
      type: "periodic",
      text: "Check deployment status daily",
      schedule: "0 9 * * *",
      timezone: "Asia/Taipei",
    });
    const updated = JSON.parse(
      readFileSync(join(workspaceDir, "events", "deploy-1700000000003.json"), "utf-8"),
    );
    expect(updated).toMatchObject({
      type: "periodic",
      text: "Check deployment status daily",
      schedule: "0 9 * * *",
      timezone: "Asia/Taipei",
    });

    await tool.execute("call-5", {
      action: "delete",
      filename: "deploy-1700000000003.json",
    });
    expect(existsSync(join(workspaceDir, "events", "deploy-1700000000003.json"))).toBe(false);
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

  test("rejects traversal and non-json filenames for read, update, and delete", async () => {
    const workspaceDir = makeWorkspace();
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });

    await expect(
      tool.execute("call-1", { action: "read", filename: "../outside.json" }),
    ).rejects.toThrow("Invalid event filename");
    await expect(
      tool.execute("call-2", { action: "delete", filename: "sub/dir.json" }),
    ).rejects.toThrow("Invalid event filename");
    await expect(
      tool.execute("call-3", {
        action: "update",
        filename: "note.txt",
        type: "immediate",
        text: "x",
      }),
    ).rejects.toThrow("Invalid event filename");
    await expect(tool.execute("call-4", { action: "read" })).rejects.toThrow(
      "`filename` is required",
    );
  });

  test("update refuses to create a new event file", async () => {
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
        action: "update",
        filename: "missing-1.json",
        type: "immediate",
        text: "Check deployment status",
      }),
    ).rejects.toThrow();
    expect(existsSync(join(workspaceDir, "events", "missing-1.json"))).toBe(false);
  });

  test("list keeps unparseable event files visible with a null payload under scope=all", async () => {
    const workspaceDir = makeWorkspace();
    mkdirSync(join(workspaceDir, "events"), { recursive: true });
    writeFileSync(join(workspaceDir, "events", "corrupt-1.json"), "{not json");
    const { tool, setEventContext } = createWorkspaceEventTool(workspaceDir);
    setEventContext({
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
    });

    // Without a payload the file cannot be attributed to a conversation, so
    // the default scope hides it; scope=all must surface it for cleanup.
    const scoped = await tool.execute("call-1", { action: "list" });
    expect(scoped.content[0]?.text).not.toContain("corrupt-1.json");

    const all = await tool.execute("call-2", { action: "list", scope: "all" });
    expect(all.content[0]?.text).toContain("corrupt-1.json");
    expect(all.content[0]?.text).toContain('"payload": null');
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
