import type { AgentConfig } from "../types.js";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadConversationWorkspaceOverride } from "../config.js";
import {
  createOfficeAddress,
  createWorkspace,
  officeStateDir,
  type Office,
} from "../office/index.js";
import {
  applyConversationSettings,
  applyConversationWorkspacePolicy,
  applyGlobalSettings,
  applyGlobalWorkspacePolicy,
} from "../settings-mutation.js";

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
      sandbox: { image: { workspaceMount: "full" } },
    });
    expect(result).toEqual({ ok: true, runtimeSwitched: null });
    expect(runtime.switchConversationModel).not.toHaveBeenCalled();
    const written = JSON.parse(readFileSync(conversationSettingsFile("C1"), "utf-8"));
    expect(written.sandbox.image.workspaceMount).toBe("full");
  });

  test("no runtime (portal without bridge): writes, reports null", () => {
    const result = applyConversationSettings(undefined, office, {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(result).toEqual({ ok: true, runtimeSwitched: null });
    expect(existsSync(conversationSettingsFile("C1"))).toBe(true);
  });

  test("rejects an unclassified mutation key before writing", () => {
    const unsupportedPatch = { futureSetting: true } as Partial<AgentConfig>;

    expect(() => applyConversationSettings(undefined, office, unsupportedPatch)).toThrow(
      "Unsupported settings mutation key: futureSetting",
    );
    expect(existsSync(conversationSettingsFile("C1"))).toBe(false);
  });

  test("rejects an unclassified global mutation key before writing", () => {
    const unsupportedPatch = { futureSetting: true } as Partial<AgentConfig>;

    expect(() => applyGlobalSettings(undefined, unsupportedPatch)).toThrow(
      "Unsupported settings mutation key: futureSetting",
    );
    expect(existsSync(join(stateDir, "settings.json"))).toBe(false);
  });
});

describe("applyConversationWorkspacePolicy", () => {
  test("writes the explicit choice, clears the legacy mount, keeps other leaves", () => {
    applyConversationSettings(undefined, office, {
      sandbox: { cpus: "2", image: { workspaceMount: "full" } },
    });
    const runtime = {
      switchConversationModel: vi.fn(),
      refreshConversationEnvironment: vi.fn().mockReturnValue(true),
    };
    const result = applyConversationWorkspacePolicy(runtime, office, {
      doorPolicy: "trusted",
      layout: "shared-support",
    });
    expect(result).toEqual({ ok: true, runtimeSwitched: true });
    expect(runtime.refreshConversationEnvironment).toHaveBeenCalledWith(C1);
    const written = JSON.parse(readFileSync(conversationSettingsFile("C1"), "utf-8"));
    expect(written.sandbox.workspace).toEqual({ doorPolicy: "trusted", layout: "shared-support" });
    expect(written.sandbox.image).toBeUndefined();
    expect(written.sandbox.cpus).toBe("2");
  });

  test("null clears both the explicit override and the legacy mount", () => {
    applyConversationSettings(undefined, office, {
      sandbox: { image: { workspaceMount: "private" } },
    });
    const result = applyConversationWorkspacePolicy(undefined, office, null);
    expect(result).toEqual({ ok: true, runtimeSwitched: null });
    const written = JSON.parse(readFileSync(conversationSettingsFile("C1"), "utf-8"));
    expect(written.sandbox).toBeUndefined();
    expect(loadConversationWorkspaceOverride(office)).toBeNull();
  });

  test("busy conversation refuses without writing", () => {
    const runtime = {
      switchConversationModel: vi.fn(),
      refreshConversationEnvironment: vi.fn().mockReturnValue(false),
    };
    const result = applyConversationWorkspacePolicy(runtime, office, {
      doorPolicy: "isolated",
    });
    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(existsSync(conversationSettingsFile("C1"))).toBe(false);
  });

  test("legacy workspaceMount reads back as a trusted override", () => {
    applyConversationSettings(undefined, office, {
      sandbox: { image: { workspaceMount: "full" } },
    });
    expect(loadConversationWorkspaceOverride(office)).toEqual({
      doorPolicy: "trusted",
      layout: "full",
    });
  });
});

describe("applyGlobalWorkspacePolicy", () => {
  test("writes the global default and reports busy conversations", () => {
    const busyOffice = createOfficeAddress("slack", "C9");
    const runtime = { refreshAllConversations: vi.fn().mockReturnValue({ busy: [busyOffice] }) };
    const result = applyGlobalWorkspacePolicy(runtime, { doorPolicy: "trusted", layout: "full" });
    expect(result).toEqual({ ok: true, staleConversations: [busyOffice] });
    const written = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf-8"));
    expect(written.sandbox.workspace).toEqual({ doorPolicy: "trusted", layout: "full" });
    expect(written.sandbox.cpus).toBe("0.5");
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
