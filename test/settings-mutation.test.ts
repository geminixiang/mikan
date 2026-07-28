import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createOfficeAddress, officeStateDir } from "../src/office-address.js";
import {
  applyConversationSettings,
  applyConversationSettingsByRawId,
  applyGlobalSettings,
} from "../src/settings-mutation.js";
import { OfficeRegistry } from "../src/office-registry.js";

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
      "C1",
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

describe("applyConversationSettingsByRawId", () => {
  test("resolves the office through the registry before writing", () => {
    new OfficeRegistry(stateDir).recordOffice(C1);

    const result = applyConversationSettingsByRawId(undefined, workingDir, "C1", {
      slack: { replyMode: "thread" },
    });

    expect(result).toEqual({ ok: true, runtimeSwitched: null });
    expect(existsSync(conversationSettingsFile("C1"))).toBe(true);
  });

  test("fails loudly for an unknown raw id instead of guessing a directory", () => {
    expect(() =>
      applyConversationSettingsByRawId(undefined, workingDir, "C-unknown", {
        slack: { replyMode: "thread" },
      }),
    ).toThrow(/No office is registered/);
  });
});

describe("applyGlobalSettings", () => {
  test("llm change writes, refreshes all, reports busy conversations as stale", () => {
    const runtime = { refreshAllConversations: vi.fn().mockReturnValue({ busy: ["C9"] }) };
    const result = applyGlobalSettings(runtime, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(result).toEqual({ ok: true, staleConversations: ["C9"] });
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
