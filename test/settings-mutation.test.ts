import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadConversationWorkspaceOverride } from "../src/config.js";
import {
  createOfficeAddress,
  conversationOfficeDir,
  officeStateDir,
} from "../src/office-address.js";
import {
  applyConversationSettings,
  applyConversationWorkspacePolicy,
  applyGlobalSettings,
  applyGlobalWorkspacePolicy,
} from "../src/settings-mutation.js";

const C1 = createOfficeAddress("slack", "C1");

let stateDir: string;
let workingDir: string;

beforeEach(() => {
  const base = join(tmpdir(), `mikan-mutation-${Date.now()}-${Math.random()}`);
  stateDir = join(base, "state");
  workingDir = join(base, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(workingDir, { recursive: true });
  process.env.MIKAN_STATE_DIR = stateDir;
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
    const runtime = { switchConversationModel: vi.fn().mockReturnValue(true) };
    const result = applyConversationSettings(runtime, workingDir, C1, {
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
    const runtime = { switchConversationModel: vi.fn().mockReturnValue(false) };
    const result = applyConversationSettings(runtime, workingDir, C1, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(existsSync(conversationSettingsFile("C1"))).toBe(false);
  });

  test("non-llm patch writes without touching runners", () => {
    const runtime = { switchConversationModel: vi.fn().mockReturnValue(false) };
    const result = applyConversationSettings(runtime, workingDir, C1, {
      sandbox: { image: { workspaceMount: "full" } },
    });
    expect(result).toEqual({ ok: true, runtimeSwitched: null });
    expect(runtime.switchConversationModel).not.toHaveBeenCalled();
    const written = JSON.parse(readFileSync(conversationSettingsFile("C1"), "utf-8"));
    expect(written.sandbox.image.workspaceMount).toBe("full");
  });

  test("no runtime (portal without bridge): writes, reports null", () => {
    const result = applyConversationSettings(undefined, workingDir, C1, {
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(result).toEqual({ ok: true, runtimeSwitched: null });
    expect(existsSync(conversationSettingsFile("C1"))).toBe(true);
  });
});

describe("applyConversationWorkspacePolicy", () => {
  const scope = () => ({ address: C1, conversationDir: conversationOfficeDir(workingDir, C1) });

  test("writes the explicit choice, clears the legacy mount, keeps other leaves", () => {
    applyConversationSettings(undefined, workingDir, C1, {
      sandbox: { cpus: "2", image: { workspaceMount: "full" } },
    });
    const runtime = {
      switchConversationModel: vi.fn(),
      refreshConversationEnvironment: vi.fn().mockReturnValue(true),
    };
    const result = applyConversationWorkspacePolicy(runtime, workingDir, C1, {
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
    applyConversationSettings(undefined, workingDir, C1, {
      sandbox: { image: { workspaceMount: "private" } },
    });
    const result = applyConversationWorkspacePolicy(undefined, workingDir, C1, null);
    expect(result).toEqual({ ok: true, runtimeSwitched: null });
    const written = JSON.parse(readFileSync(conversationSettingsFile("C1"), "utf-8"));
    expect(written.sandbox).toBeUndefined();
    expect(loadConversationWorkspaceOverride(scope())).toBeNull();
  });

  test("busy conversation refuses without writing", () => {
    const runtime = {
      switchConversationModel: vi.fn(),
      refreshConversationEnvironment: vi.fn().mockReturnValue(false),
    };
    const result = applyConversationWorkspacePolicy(runtime, workingDir, C1, {
      doorPolicy: "isolated",
    });
    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(existsSync(conversationSettingsFile("C1"))).toBe(false);
  });

  test("legacy workspaceMount reads back as a trusted override", () => {
    applyConversationSettings(undefined, workingDir, C1, {
      sandbox: { image: { workspaceMount: "full" } },
    });
    expect(loadConversationWorkspaceOverride(scope())).toEqual({
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
