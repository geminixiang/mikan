import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { MutableModels, UserMessage } from "@earendil-works/pi-ai";
import {
  commitOfficeDream,
  DreamScheduler,
  generateMemoryAnchor,
  prepareOfficeDream,
} from "../dream/index.js";
import type { DreamPlan, DreamRuntime, DreamState } from "../dream/types.js";
import { MikanAgentSession, MikanModels, SessionStore } from "../harness/index.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office, Workspace } from "../office/index.js";
import { createConversationRuntime } from "../runtime/conversation-runtime.js";

const DREAM_NOW = new Date("2026-06-01T19:00:00.000Z"); // 03:00 in Taiwan

let root: string;
let office: Office;
let workspace: Workspace;
let originalStateDir: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  originalStateDir = process.env.MIKAN_STATE_DIR;
  root = mkdtempSync(join(tmpdir(), "mikan-dream-"));
  workspace = createWorkspace({
    root: join(root, "workspace"),
    stateDir: join(root, "state"),
  });
  office = workspace.office(createOfficeAddress("slack", "C1"));
  mkdirSync(office.dir, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  if (originalStateDir === undefined) delete process.env.MIKAN_STATE_DIR;
  else process.env.MIKAN_STATE_DIR = originalStateDir;
  rmSync(root, { recursive: true, force: true });
});

async function seedSession(
  filename: string,
  sessionId: string,
  text: string,
  timestamp: string,
): Promise<string> {
  vi.setSystemTime(new Date(timestamp));
  const file = join(office.sessionsDir, filename);
  const store = await SessionStore.create(file, office.dir, { id: sessionId });
  await store.appendMessage(userMessage(text));
  await store.close();
  return file;
}

async function appendSessionMessage(file: string, text: string, timestamp: string): Promise<void> {
  vi.setSystemTime(new Date(timestamp));
  const store = await SessionStore.open(file, office.dir);
  await store.appendMessage(userMessage(text));
  await store.close();
}

function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function readDreamState(): DreamState {
  return JSON.parse(readFileSync(join(office.stateDir, "dream.json"), "utf-8")) as DreamState;
}

function requirePlan(plan: DreamPlan | null): DreamPlan {
  expect(plan).not.toBeNull();
  return plan!;
}

function createFauxModels(): {
  models: MikanModels;
  faux: ReturnType<typeof fauxProvider>;
} {
  process.env.MIKAN_STATE_DIR = workspace.stateDir;
  mkdirSync(workspace.stateDir, { recursive: true });
  writeFileSync(
    join(workspace.stateDir, "settings.json"),
    JSON.stringify({ llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" } }),
  );
  const models = MikanModels.create({
    modelsJsonPath: join(workspace.stateDir, "models.json"),
  });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux };
}

describe("Dream authority", () => {
  test.each([
    ["before the window", "2026-06-01T17:59:59.999Z", false],
    ["at the window start", "2026-06-01T18:00:00.000Z", true],
    ["before the window end", "2026-06-01T20:59:59.999Z", true],
    ["at the window end", "2026-06-01T21:00:00.000Z", false],
  ])("runs %s in Taiwan time", async (_label, now, eligible) => {
    await seedSession("a.jsonl", "session-a", "old evidence", "2026-06-01T10:00:00.000Z");

    expect((await prepareOfficeDream(office, new Date(now))) !== null).toBe(eligible);
  });

  test("requires the latest settled evidence to be idle for five hours", async () => {
    await seedSession("a.jsonl", "session-a", "evidence", "2026-06-01T14:00:00.000Z");

    expect(await prepareOfficeDream(office, new Date("2026-06-01T18:59:59.999Z"))).toBeNull();
    expect(await prepareOfficeDream(office, DREAM_NOW)).not.toBeNull();
  });

  test("collects checkpoint increments across every office session", async () => {
    const firstFile = await seedSession(
      "a.jsonl",
      "session-a",
      "first session",
      "2026-06-01T12:00:00.000Z",
    );
    await seedSession("b.jsonl", "session-b", "second session", "2026-06-01T13:00:00.000Z");

    const firstPlan = requirePlan(await prepareOfficeDream(office, DREAM_NOW));
    expect(firstPlan.evidence.map((session) => session.sessionId)).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(firstPlan.evidence.map((session) => session.entries.length)).toEqual([1, 1]);

    commitOfficeDream(office, firstPlan, "# Memory anchor\n");
    expect(await prepareOfficeDream(office, DREAM_NOW)).toBeNull();

    await appendSessionMessage(firstFile, "new first-session evidence", "2026-06-01T13:30:00.000Z");
    const incrementalPlan = requirePlan(await prepareOfficeDream(office, DREAM_NOW));
    expect(incrementalPlan.evidence).toHaveLength(1);
    expect(incrementalPlan.evidence[0]?.sessionId).toBe("session-a");
    expect(incrementalPlan.evidence[0]?.entries).toHaveLength(1);
    expect(incrementalPlan.checkpoint.sessions["session-b"]).toEqual(
      firstPlan.checkpoint.sessions["session-b"],
    );
  });

  test("bounds each evidence batch and advances only through consumed entries", async () => {
    const file = await seedSession(
      "a.jsonl",
      "session-a",
      "a".repeat(40_000),
      "2026-06-01T12:00:00.000Z",
    );
    await appendSessionMessage(file, "b".repeat(40_000), "2026-06-01T12:01:00.000Z");
    await appendSessionMessage(file, "c".repeat(40_000), "2026-06-01T12:02:00.000Z");

    const firstPlan = requirePlan(await prepareOfficeDream(office, DREAM_NOW));
    expect(firstPlan.evidence[0]?.entries).toHaveLength(2);
    commitOfficeDream(office, firstPlan, "first batch\n");

    const secondPlan = requirePlan(await prepareOfficeDream(office, DREAM_NOW));
    expect(secondPlan.evidence[0]?.entries).toHaveLength(1);
    expect(secondPlan.evidence[0]?.entries[0]?.entryId).not.toBe(
      firstPlan.evidence[0]?.entries[0]?.entryId,
    );
  });

  test("uses a bounded representation for one oversized entry", async () => {
    await seedSession("a.jsonl", "session-a", '界\\"'.repeat(100_000), "2026-06-01T12:00:00.000Z");

    const plan = requirePlan(await prepareOfficeDream(office, DREAM_NOW));
    const entry = plan.evidence[0]?.entries[0];
    expect(entry?.originalBytes).toBeGreaterThan(64 * 1024);
    expect(entry?.serialized).toContain("Dream evidence truncated");
    expect(Buffer.byteLength(JSON.stringify(plan.evidence), "utf8")).toBeLessThanOrEqual(64 * 1024);
  });

  test("writes MEMORY.md before the host-private checkpoint", async () => {
    await seedSession("a.jsonl", "session-a", "evidence", "2026-06-01T12:00:00.000Z");
    const plan = requirePlan(await prepareOfficeDream(office, DREAM_NOW));

    commitOfficeDream(office, plan, "durable anchor\n");

    expect(readFileSync(office.memoryPath, "utf-8")).toBe("durable anchor\n");
    expect(readDreamState()).toEqual(plan.checkpoint);
    expect(existsSync(join(office.dir, "dream.json"))).toBe(false);
    expect(statSync(join(office.stateDir, "dream.json")).mode & 0o777).toBe(0o600);
  });

  test("does not advance dream.json when the memory write fails", async () => {
    await seedSession("a.jsonl", "session-a", "evidence", "2026-06-01T12:00:00.000Z");
    const plan = requirePlan(await prepareOfficeDream(office, DREAM_NOW));
    rmSync(office.dir, { recursive: true, force: true });

    expect(() => commitOfficeDream(office, plan, "memory")).toThrow();
    expect(existsSync(join(office.stateDir, "dream.json"))).toBe(false);
  });

  test("fails closed when a saved throughEntryId is absent", async () => {
    await seedSession("a.jsonl", "session-a", "evidence", "2026-06-01T12:00:00.000Z");
    mkdirSync(office.stateDir, { recursive: true });
    const invalidState: DreamState = {
      version: 1,
      sessions: { "session-a": { throughEntryId: "missing-entry" } },
    };
    const statePath = join(office.stateDir, "dream.json");
    const content = `${JSON.stringify(invalidState)}\n`;
    writeFileSync(statePath, content);

    await expect(prepareOfficeDream(office, DREAM_NOW)).rejects.toThrow(
      "Dream checkpoint entry not found: missing-entry",
    );
  });

  test("does not call the provider when the office has no new evidence", async () => {
    const { models, faux } = createFauxModels();
    faux.setResponses([
      () => {
        throw new Error("provider must not be called");
      },
    ]);
    const runtime = createConversationRuntime({
      workspace,
      sandbox: { type: "host" },
      models,
    });

    await expect(runtime.runDream(office.address, DREAM_NOW)).resolves.toBe(false);
    await runtime.shutdown();
  });

  test("generates a complete anchor without triggering the hard timeout", async () => {
    await seedSession("a.jsonl", "session-a", "launch decision", "2026-06-01T12:00:00.000Z");
    writeFileSync(office.memoryPath, "old anchor\n");
    const plan = requirePlan(await prepareOfficeDream(office, DREAM_NOW));
    const { models, faux } = createFauxModels();
    faux.setResponses([
      (context) => {
        const prompt = JSON.stringify(context);
        expect(prompt).toContain("old anchor");
        expect(prompt).toContain("launch decision");
        expect(prompt).toContain("Live sources and current API evidence outrank");
        expect(prompt).toContain("never present the cached observation as current truth");
        return fauxAssistantMessage("# Revised anchor");
      },
    ]);

    const abort = vi.spyOn(MikanAgentSession.prototype, "abort");
    await expect(generateMemoryAnchor(office, plan, models)).resolves.toBe("# Revised anchor\n");
    expect(abort).not.toHaveBeenCalled();
  });

  test("aborts a hanging generation at the hard deadline and rejects", async () => {
    await seedSession("a.jsonl", "session-a", "evidence", "2026-06-01T12:00:00.000Z");
    const plan = requirePlan(await prepareOfficeDream(office, DREAM_NOW));
    const { models, faux } = createFauxModels();
    let providerSignal: AbortSignal | undefined;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => (providerStarted = resolve));
    faux.setResponses([
      (_context, options) => {
        providerSignal = options?.signal;
        providerStarted();
        return new Promise(() => {});
      },
    ]);
    const abort = vi.spyOn(MikanAgentSession.prototype, "abort");

    const generation = generateMemoryAnchor(office, plan, models);
    const rejected = expect(generation).rejects.toThrow(
      "Dream generation timed out after 120000ms",
    );
    await started;
    await vi.advanceTimersByTimeAsync(120_000);

    await rejected;
    expect(abort).toHaveBeenCalledOnce();
    expect(providerSignal?.aborted).toBe(true);
    expect(existsSync(office.memoryPath)).toBe(false);
    expect(existsSync(join(office.stateDir, "dream.json"))).toBe(false);
  });

  test("does not commit after timeout when the provider completes late", async () => {
    await seedSession("a.jsonl", "session-a", "evidence", "2026-06-01T12:00:00.000Z");
    const { models, faux } = createFauxModels();
    let resolveResponse!: (message: ReturnType<typeof fauxAssistantMessage>) => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => (providerStarted = resolve));
    const lateResponse = new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
      resolveResponse = resolve;
    });
    faux.setResponses([
      () => {
        providerStarted();
        return lateResponse;
      },
    ]);
    const runtime = createConversationRuntime({
      workspace,
      sandbox: { type: "host" },
      models,
    });

    const dream = runtime.runDream(office.address, DREAM_NOW);
    const rejected = expect(dream).rejects.toThrow("Dream generation timed out after 120000ms");
    await started;
    await vi.advanceTimersByTimeAsync(120_000);

    await rejected;
    expect(existsSync(office.memoryPath)).toBe(false);
    expect(existsSync(join(office.stateDir, "dream.json"))).toBe(false);

    resolveResponse(fauxAssistantMessage("late anchor"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(existsSync(office.memoryPath)).toBe(false);
    expect(existsSync(join(office.stateDir, "dream.json"))).toBe(false);
    await runtime.shutdown();
  });

  test("absorbs a late provider rejection without committing", async () => {
    await seedSession("a.jsonl", "session-a", "evidence", "2026-06-01T12:00:00.000Z");
    const { models, faux } = createFauxModels();
    let rejectResponse!: (error: Error) => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => (providerStarted = resolve));
    const lateResponse = new Promise<ReturnType<typeof fauxAssistantMessage>>(
      (_resolve, reject) => {
        rejectResponse = reject;
      },
    );
    faux.setResponses([
      () => {
        providerStarted();
        return lateResponse;
      },
    ]);
    const runtime = createConversationRuntime({
      workspace,
      sandbox: { type: "host" },
      models,
    });

    const dream = runtime.runDream(office.address, DREAM_NOW);
    const rejected = expect(dream).rejects.toThrow("Dream generation timed out after 120000ms");
    await started;
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;

    rejectResponse(new Error("late provider failure"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(existsSync(office.memoryPath)).toBe(false);
    expect(existsSync(join(office.stateDir, "dream.json"))).toBe(false);
    await runtime.shutdown();
  });

  test("scheduler shutdown drains a timed-out Dream without starting the next office", async () => {
    await seedSession("a.jsonl", "session-a", "evidence", "2026-06-01T12:00:00.000Z");
    const plan = requirePlan(await prepareOfficeDream(office, DREAM_NOW));
    const other = workspace.office(createOfficeAddress("discord", "D1"));
    office.ensure();
    other.ensure();
    const { models, faux } = createFauxModels();
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => (providerStarted = resolve));
    faux.setResponses([
      () => {
        providerStarted();
        return new Promise(() => {});
      },
    ]);
    const runDream = vi.fn<DreamRuntime["runDream"]>(async (address) => {
      if (
        address.platform === office.address.platform &&
        address.conversationId === office.address.conversationId
      ) {
        await generateMemoryAnchor(office, plan, models);
      }
      return true;
    });
    const scheduler = new DreamScheduler(workspace, { runDream });

    const sweep = scheduler.runOnce(DREAM_NOW);
    await started;
    const stopping = scheduler.stop();
    let stopped = false;
    void stopping.then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(runDream).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(120_000);
    await expect(stopping).resolves.toBeUndefined();
    await expect(sweep).resolves.toBeUndefined();
    expect(runDream).toHaveBeenCalledOnce();
  });

  test("rejects an early-stopped Dream instead of committing partial memory", async () => {
    await seedSession("a.jsonl", "session-a", "evidence", "2026-06-01T12:00:00.000Z");
    const plan = requirePlan(await prepareOfficeDream(office, DREAM_NOW));
    const { models, faux } = createFauxModels();
    faux.setResponses([fauxAssistantMessage("partial", { stopReason: "length" })]);

    await expect(generateMemoryAnchor(office, plan, models)).rejects.toThrow("Dream stopped early");
    expect(existsSync(office.memoryPath)).toBe(false);
    expect(existsSync(join(office.stateDir, "dream.json"))).toBe(false);
  });

  test("scheduler skips overlapping sweeps and drains only active office work on stop", async () => {
    office.ensure();
    workspace.office(createOfficeAddress("discord", "D1")).ensure();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runDream = vi.fn<DreamRuntime["runDream"]>(async () => {
      await gate;
      return true;
    });
    const scheduler = new DreamScheduler(workspace, { runDream });

    const first = scheduler.runOnce(DREAM_NOW);
    const overlapping = scheduler.runOnce(DREAM_NOW);
    const stopping = scheduler.stop();
    await Promise.resolve();

    expect(overlapping).toBe(first);
    expect(runDream).toHaveBeenCalledOnce();
    let stopped = false;
    void stopping.then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await expect(stopping).resolves.toBeUndefined();
    await expect(first).resolves.toBeUndefined();
  });

  test("scheduler visits registered offices and continues after one failure", async () => {
    office.ensure();
    const other = workspace.office(createOfficeAddress("discord", "D1"));
    other.ensure();
    const runDream = vi.fn<DreamRuntime["runDream"]>().mockImplementation(async (address) => {
      if (address.platform === "discord") throw new Error("provider unavailable");
      return true;
    });
    const scheduler = new DreamScheduler(workspace, { runDream });

    await scheduler.runOnce(DREAM_NOW);

    expect(runDream).toHaveBeenCalledTimes(2);
    expect(runDream).toHaveBeenCalledWith(office.address, DREAM_NOW);
    expect(runDream).toHaveBeenCalledWith(other.address, DREAM_NOW);
  });
});
