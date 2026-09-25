import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadOfficeVisibilityOverride } from "../settings/index.js";
import { createOfficeAddress, createWorkspace, officeStateDir } from "../office/index.js";
import type { Office } from "../office/types.js";
import {
  applyConversationSettings,
  applyOfficeVisibility,
  applyGlobalSettings,
} from "../settings/apply.js";

const C1 = createOfficeAddress("slack", "C1");

let stateDir: string;
let office: Office;

beforeEach(() => {
  const base = join(tmpdir(), `mikan-mutation-${Date.now()}-${Math.random()}`);
  stateDir = join(base, "state");
  const workingDir = join(base, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workingDir, { recursive: true });
  process.env.MIKAN_STATE_DIR = stateDir;
  office = createWorkspace({ root: workingDir, stateDir }).office(C1);
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  rmSync(join(stateDir, ".."), { recursive: true, force: true });
});

function conversationSettingsFile(conversationId: string): string {
  return join(
    officeStateDir(stateDir, createOfficeAddress("slack", conversationId)),
    "settings.json",
  );
}

describe("applyConversationSettings", () => {
  test("llm change clears cached runners, then writes", () => {
    const runtime = {
      switchConversationModel: vi.fn().mockReturnValue(true),
      refreshConversationEnvironment: vi.fn(),
    };
    const result = applyConversationSettings(runtime, office, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(result).toEqual({ ok: true, runtimeSwitched: true });
    expect(runtime.switchConversationModel).toHaveBeenCalledWith(
      C1,
      "anthropic",
      "claude-sonnet-4-6",
    );
    const written = JSON.parse(readFileSync(conversationSettingsFile("C1"), "utf-8"));
    expect(written.llm.model).toBe("claude-sonnet-4-6");
  });

  test("busy conversation refuses: no write, disk and cache stay agreed", () => {
    const runtime = {
      switchConversationModel: vi.fn().mockReturnValue(false),
      refreshConversationEnvironment: vi.fn(),
    };
    const result = applyConversationSettings(runtime, office, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(existsSync(conversationSettingsFile("C1"))).toBe(false);
  });

  test("non-llm patch writes without touching runners", () => {
    const runtime = {
      switchConversationModel: vi.fn().mockReturnValue(false),
      refreshConversationEnvironment: vi.fn(),
    };
    const result = applyConversationSettings(runtime, office, {
      sandbox: { memory: "2g" },
    });
    expect(result).toEqual({ ok: true, runtimeSwitched: null });
    expect(runtime.switchConversationModel).not.toHaveBeenCalled();
    const written = JSON.parse(readFileSync(conversationSettingsFile("C1"), "utf-8"));
    expect(written.sandbox.memory).toBe("2g");
  });

  test("no runtime (portal without bridge): writes, reports null", () => {
    const result = applyConversationSettings(undefined, office, {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(result).toEqual({ ok: true, runtimeSwitched: null });
    expect(existsSync(conversationSettingsFile("C1"))).toBe(true);
  });
});

describe("applyOfficeVisibility", () => {
  test("writes the private override, clears the runner, keeps other settings", () => {
    applyConversationSettings(undefined, office, { sandbox: { cpus: "2" } });
    const runtime = {
      switchConversationModel: vi.fn(),
      refreshConversationEnvironment: vi.fn().mockReturnValue(true),
    };
    const result = applyOfficeVisibility(runtime, office, "private");
    expect(result).toEqual({ ok: true, runtimeSwitched: true });
    expect(runtime.refreshConversationEnvironment).toHaveBeenCalledWith(C1);
    const written = JSON.parse(readFileSync(conversationSettingsFile("C1"), "utf-8"));
    expect(written.office).toEqual({ visibility: "private" });
    expect(written.sandbox.cpus).toBe("2");
    expect(loadOfficeVisibilityOverride(office)).toBe("private");
  });

  test("null clears the override and a later generic patch does not resurrect or drop it", () => {
    applyOfficeVisibility(undefined, office, "private");
    applyConversationSettings(undefined, office, { sandbox: { cpus: "1" } });
    expect(loadOfficeVisibilityOverride(office)).toBe("private");

    const result = applyOfficeVisibility(undefined, office, null);
    expect(result).toEqual({ ok: true, runtimeSwitched: null });
    const written = JSON.parse(readFileSync(conversationSettingsFile("C1"), "utf-8"));
    expect(written.office).toBeUndefined();
    expect(written.sandbox.cpus).toBe("1");
    expect(loadOfficeVisibilityOverride(office)).toBeNull();
  });

  test("busy conversation refuses without writing", () => {
    const runtime = {
      switchConversationModel: vi.fn(),
      refreshConversationEnvironment: vi.fn().mockReturnValue(false),
    };
    const result = applyOfficeVisibility(runtime, office, "private");
    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(existsSync(conversationSettingsFile("C1"))).toBe(false);
  });
});

describe("applyGlobalSettings", () => {
  test("llm change writes, refreshes all, reports busy conversations as stale", () => {
    const busyOffice = createOfficeAddress("slack", "C9");
    const runtime = { refreshAllConversations: vi.fn().mockReturnValue({ busy: [busyOffice] }) };
    const result = applyGlobalSettings(runtime, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(result).toEqual({ ok: true, staleConversations: [busyOffice] });
    expect(runtime.refreshAllConversations).toHaveBeenCalledOnce();
    const written = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf-8"));
    expect(written.llm.model).toBe("claude-sonnet-4-6");
  });

  test("non-llm global change never touches runners", () => {
    const runtime = { refreshAllConversations: vi.fn() };
    const result = applyGlobalSettings(runtime, { sandbox: { cpus: "2" } });
    expect(result).toEqual({ ok: true, staleConversations: [] });
    expect(runtime.refreshAllConversations).not.toHaveBeenCalled();
  });
});
