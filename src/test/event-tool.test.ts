import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { OfficeEventStore, officeEventsDir } from "../events/index.js";
import type { EventPayload, EventStore } from "../events/index.js";
import { createEventTool } from "../harness/tools/event.js";
import { createOfficeAddress, createWorkspace, type Office } from "../office/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-event-tool-test-"));
  mkdirSync(join(dir, "workspace"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function office(platform: "slack" | "discord" = "slack", conversationId = "C123"): Office {
  const value = createWorkspace({
    root: join(dir, "workspace"),
    stateDir: join(dir, "state"),
  }).office(createOfficeAddress(platform, conversationId));
  value.ensure();
  return value;
}

const context = {
  platform: "slack",
  conversationId: "C123",
  conversationKind: "shared" as const,
  userId: "U123",
};

function officeTool(own: Office = office()) {
  const created = createEventTool(new OfficeEventStore(own));
  created.setEventContext(context);
  return { ...created, own };
}

function fakeStore(overrides: Partial<EventStore>): EventStore {
  return {
    address: createOfficeAddress("slack", "C123"),
    async create() {
      throw new Error("not implemented");
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
    ...overrides,
  };
}

describe("createEventTool", () => {
  test("writes a top-level Slack event into the office's host-only events dir", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000000);
    const { tool, own } = officeTool();

    const result = await tool.execute("call-1", {
      label: "deploy",
      type: "immediate",
      text: "Check deployment status",
      filenamePrefix: " Deploy / Prod ",
    });

    const files = readdirSync(officeEventsDir(own));
    expect(files).toEqual(["deploy-prod-1700000000000.json"]);
    expect(JSON.parse(readFileSync(join(officeEventsDir(own), files[0]!), "utf-8"))).toEqual({
      type: "immediate",
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
      text: "Check deployment status",
    });
    expect(existsSync(join(dir, "workspace", "events"))).toBe(false);
    expect(result.content[0]?.text).toContain(
      "Queued immediate event deploy-prod-1700000000000.json",
    );
  });

  test("creates through the injected store", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000002);
    const writes: Array<{ filename: string; payload: EventPayload }> = [];
    const { tool, setEventContext } = createEventTool(
      fakeStore({
        async create(filename, payload) {
          writes.push({ filename, payload });
          return { path: `/state/events/${filename}`, size: 123 };
        },
      }),
    );
    setEventContext(context);

    await tool.execute("call-1", { type: "immediate", text: "Check", filenamePrefix: "deploy" });

    expect(writes).toEqual([
      {
        filename: "deploy-1700000000002.json",
        payload: {
          type: "immediate",
          platform: "slack",
          conversationId: "C123",
          conversationKind: "shared",
          userId: "U123",
          text: "Check",
        },
      },
    ]);
  });

  test("surfaces store write failures", async () => {
    const { tool, setEventContext } = createEventTool(
      fakeStore({
        async create() {
          throw new Error("control plane unavailable");
        },
      }),
    );
    setEventContext(context);
    await expect(tool.execute("call-1", { type: "immediate", text: "x" })).rejects.toThrow(
      "control plane unavailable",
    );
  });

  test("refuses a context that does not match the store's office", async () => {
    const { tool, setEventContext } = createEventTool(new OfficeEventStore(office()));
    setEventContext({ ...context, conversationId: "C999" });
    await expect(tool.execute("call-1", { type: "immediate", text: "x" })).rejects.toThrow(
      "Event context does not match the current office",
    );
    await expect(tool.execute("call-2", { action: "list" })).resolves.toBeTruthy();
  });

  test("rejects scope=all even when injected directly", async () => {
    const { tool } = officeTool();
    await expect(
      tool.execute("call-1", JSON.parse('{"action":"list","scope":"all"}')),
    ).rejects.toThrow("Cross-office event access is not authorized");
  });

  test("another office's events are unreachable by filename", async () => {
    const other = office("slack", "C999");
    await new OfficeEventStore(other).create("foreign.json", {
      type: "immediate",
      platform: "slack",
      conversationId: "C999",
      text: "PRIVATE_FIXTURE",
    });
    const { tool } = officeTool(office("slack", "C123"));

    for (const action of ["read", "update", "delete"] as const) {
      await expect(
        tool.execute("foreign", {
          action,
          filename: "foreign.json",
          type: "immediate",
          text: "REPLACEMENT_FIXTURE",
        }),
      ).rejects.toThrow(/not found in the current office/);
    }
    expect((await new OfficeEventStore(other).read("foreign.json")).payload.text).toBe(
      "PRIVATE_FIXTURE",
    );
    const listed = await tool.execute("list", { action: "list" });
    expect(listed.content[0]?.text).not.toContain("foreign.json");
  });

  test("supports list, read, update, and delete", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000003);
    const { tool, own } = officeTool();
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
    const path = join(officeEventsDir(own), "deploy-1700000000003.json");
    expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({
      type: "periodic",
      text: "Check deployment status daily",
      schedule: "0 9 * * *",
      timezone: "Asia/Taipei",
    });

    await tool.execute("call-5", { action: "delete", filename: "deploy-1700000000003.json" });
    expect(existsSync(path)).toBe(false);
  });

  test("requires event context before execution", async () => {
    const { tool } = createEventTool(new OfficeEventStore(office()));
    await expect(tool.execute("call-1", { type: "immediate", text: "x" })).rejects.toThrow(
      "Event context not configured",
    );
  });

  test("one-shot event carries no thread state", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000200);
    const { tool, own } = officeTool();
    await tool.execute("call-1", {
      type: "one-shot",
      text: "Follow up",
      at: "2099-01-01T09:00:00+08:00",
      filenamePrefix: "followup",
    });
    const payload = JSON.parse(
      readFileSync(join(officeEventsDir(own), "followup-1700000000200.json"), "utf-8"),
    );
    expect(payload).toEqual({
      type: "one-shot",
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
      text: "Follow up",
      at: "2099-01-01T09:00:00+08:00",
    });
    expect(payload).not.toHaveProperty("threadTs");
    expect(payload).not.toHaveProperty("sessionKey");
  });

  test.each(["../escape.json", "nested/file.json", "plain.txt", "  "])(
    "rejects unsafe filename %j for read, update, and delete",
    async (filename) => {
      const { tool } = officeTool();
      for (const action of ["read", "update", "delete"] as const) {
        await expect(
          tool.execute("call", { action, filename, type: "immediate", text: "x" }),
        ).rejects.toThrow(/Invalid event filename|`filename` is required/);
      }
    },
  );

  test("update refuses to create a new event file", async () => {
    const { tool, own } = officeTool();
    await expect(
      tool.execute("call-1", {
        action: "update",
        filename: "missing.json",
        type: "immediate",
        text: "x",
      }),
    ).rejects.toThrow(/not found in the current office/);
    expect(existsSync(join(officeEventsDir(own), "missing.json"))).toBe(false);
  });

  test("one-shot events require at", async () => {
    const { tool } = officeTool();
    await expect(tool.execute("call-1", { type: "one-shot", text: "x" })).rejects.toThrow(
      "`at` is required for one-shot events",
    );
  });

  test("one-shot events reject invalid timestamps", async () => {
    const { tool } = officeTool();
    await expect(
      tool.execute("call-1", { type: "one-shot", text: "x", at: "2099-13-01T00:00:00Z" }),
    ).rejects.toThrow("`at` must be a valid ISO 8601 timestamp with UTC offset");
  });

  test("one-shot events reject past timestamps", async () => {
    const { tool } = officeTool();
    await expect(
      tool.execute("call-1", { type: "one-shot", text: "x", at: "2000-01-01T00:00:00Z" }),
    ).rejects.toThrow("`at` must be in the future");
  });

  test("periodic events require schedule and timezone", async () => {
    const { tool } = officeTool();
    await expect(tool.execute("call-1", { type: "periodic", text: "x" })).rejects.toThrow(
      "`schedule` is required for periodic events",
    );
    await expect(
      tool.execute("call-2", { type: "periodic", text: "x", schedule: "0 9 * * *" }),
    ).rejects.toThrow("`timezone` is required for periodic events");
  });

  test("writes periodic event payload with context", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000300);
    const { tool, own } = officeTool();
    await tool.execute("call-1", {
      type: "periodic",
      text: "Daily standup",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
      filenamePrefix: "standup",
    });
    expect(
      JSON.parse(readFileSync(join(officeEventsDir(own), "standup-1700000000300.json"), "utf-8")),
    ).toEqual({
      type: "periodic",
      platform: "slack",
      conversationId: "C123",
      conversationKind: "shared",
      userId: "U123",
      text: "Daily standup",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Taipei",
    });
  });
});
