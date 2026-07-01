import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Agent, convertToLlm, type Model } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Models } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...actual,
    prepareCompaction: vi.fn(() => ({
      ok: true,
      value: {
        firstKeptEntryId: "kept",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 999999,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: actual.DEFAULT_COMPACTION_SETTINGS,
      },
    })),
    compact: vi.fn(async () => ({
      ok: true,
      value: { summary: "summarized history", firstKeptEntryId: "kept", tokensBefore: 999999 },
    })),
  };
});

const { checkCompaction } = await import("../src/harness/compaction-policy.js");
const { SessionManager } = await import("../src/harness/session-manager.js");
const compactionModule = await import("@earendil-works/pi-agent-core");

const TEST_MODEL: Model<Api> = {
  provider: "anthropic",
  id: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  api: "anthropic-messages",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} as Model<Api>;

const SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
const fakeModels = {} as Models;

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

let sessionDir: string;
let sessionManager: InstanceType<typeof SessionManager>;
let agent: Agent;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "mikan-compaction-policy-"));
  sessionManager = SessionManager.create(sessionDir, sessionDir);
  agent = new Agent({
    initialState: { systemPrompt: "", model: TEST_MODEL, thinkingLevel: "off", tools: [] },
    convertToLlm,
  });
  vi.clearAllMocks();
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

describe("checkCompaction", () => {
  test("does nothing when compaction is disabled", async () => {
    agent.state.messages = [
      assistantMessage({ usage: { ...assistantMessage().usage, totalTokens: 999_999 } }),
    ];
    const outcome = await checkCompaction(agent, sessionManager, fakeModels, {
      ...SETTINGS,
      enabled: false,
    });
    expect(outcome).toEqual({ compacted: false });
    expect(compactionModule.compact).not.toHaveBeenCalled();
  });

  test("does nothing when there is no assistant message yet", async () => {
    agent.state.messages = [];
    const outcome = await checkCompaction(agent, sessionManager, fakeModels, SETTINGS);
    expect(outcome.compacted).toBe(false);
  });

  test("does nothing when context usage is well under threshold", async () => {
    agent.state.messages = [
      assistantMessage({ usage: { ...assistantMessage().usage, totalTokens: 1000 } }),
    ];
    const outcome = await checkCompaction(agent, sessionManager, fakeModels, SETTINGS);
    expect(outcome).toEqual({ compacted: false });
    expect(compactionModule.compact).not.toHaveBeenCalled();
  });

  test("compacts on context overflow, reporting reason 'overflow' via onStart", async () => {
    agent.state.messages = [
      assistantMessage({
        stopReason: "error",
        errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
      }),
    ];
    const onStart = vi.fn();
    const outcome = await checkCompaction(agent, sessionManager, fakeModels, SETTINGS, onStart);

    expect(onStart).toHaveBeenCalledWith("overflow");
    expect(outcome.compacted).toBe(true);
    expect(outcome.reason).toBe("overflow");
    expect(compactionModule.compact).toHaveBeenCalled();
  });

  test("compacts once token usage crosses the threshold, reporting reason 'threshold'", async () => {
    agent.state.messages = [
      assistantMessage({ usage: { ...assistantMessage().usage, totalTokens: 190_000 } }),
    ];
    const onStart = vi.fn();
    const outcome = await checkCompaction(agent, sessionManager, fakeModels, SETTINGS, onStart);

    expect(onStart).toHaveBeenCalledWith("threshold");
    expect(outcome.compacted).toBe(true);
    expect(outcome.reason).toBe("threshold");
  });
});
