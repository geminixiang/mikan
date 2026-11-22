import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { createOfficeAddress, createWorkspace } from "@mikan/office/index.js";
import { createGlobalSettingsFile } from "@mikan/settings/index.js";
import { MikanModels } from "@mikan/harness/models.js";
import { createConversationRuntime } from "@mikan/runtime/conversation-runtime.js";
import { localRunnerFactory } from "@mikan/test/local-execution.js";
import { runtimeServices } from "@mikan/test/runtime-services.js";
import { SlackMessagingBot } from "@mikan/adapters/slack/bot.js";
import { SessionStore } from "@mikan/sessions/session-store.js";
import * as log from "@mikan/log.js";
import type {
  SlackSocketConnection,
  SlackSocketEventArgs,
  SlackWebApi,
} from "@mikan/adapters/slack/types.js";

vi.mock("@mikan/harness/jev.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mikan/harness/jev.js")>();
  return {
    ...actual,
    evaluateWithJev: async () => {
      throw new actual.JevNotConfiguredError();
    },
  };
});

const results: Record<string, unknown> = {};
afterAll(() => {
  const out = process.env.EVAL_OUT;
  if (out) writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
});

class FakeSlackSocket implements SlackSocketConnection {
  private readonly listeners = new Map<string, Array<(args: SlackSocketEventArgs) => unknown>>();
  on(event: string, listener: (args: SlackSocketEventArgs) => unknown): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  async start(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async deliver(event: string, payload: unknown): Promise<void> {
    const args: SlackSocketEventArgs = { event: payload, ack: async () => {} };
    await Promise.all((this.listeners.get(event) ?? []).map((listener) => listener(args)));
  }
}

const ok = async () => ({ ok: true });
function fakeSlackWebApi(): SlackWebApi {
  return {
    auth: { test: async () => ({ ok: true, user_id: "BOT" }) },
    chat: { postMessage: ok, postEphemeral: ok, update: ok, delete: ok },
    conversations: {
      open: ok,
      history: async () => ({ ok: true, messages: [] }),
      replies: async () => ({ ok: true, messages: [] }),
      list: async (args: unknown) => ({
        ok: true,
        channels: (args as { types?: string }).types === "im" ? [{ id: "D123", user: "U1" }] : [],
      }),
    },
    users: { list: async () => ({ ok: true, members: [] }) },
    reactions: { add: ok },
    views: { publish: ok },
    files: { uploadV2: async () => ({ ok: true, files: [] }) },
    assistant: { threads: { setSuggestedPrompts: ok, setTitle: ok } },
    apiCall: ok,
  } as SlackWebApi;
}

interface Post {
  text: string;
  thread?: string;
  ts: string;
  at: number;
}

let seq = 0;
const nextTs = () => `${Math.floor(Date.now() / 1000)}.${String(++seq).padStart(6, "0")}`;

class World {
  readonly dir: string;
  readonly stateDir: string;
  readonly workspace;
  readonly models;
  readonly faux = fauxProvider();
  posts: Post[] = [];
  runtime!: ReturnType<typeof createConversationRuntime>;
  bot!: SlackMessagingBot;
  socket!: FakeSlackSocket;

  constructor(existing?: string) {
    this.dir = existing ?? mkdtempSync(join(tmpdir(), "mikan-subagent-eval-"));
    this.stateDir = join(this.dir, "state");
    if (!existing) {
      mkdirSync(this.stateDir);
      createGlobalSettingsFile(this.stateDir);
      writeFileSync(
        join(this.stateDir, "settings.json"),
        JSON.stringify({ llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" } }),
      );
    }
    this.workspace = createWorkspace({ root: this.dir, stateDir: this.stateDir });
    this.models = MikanModels.create({ modelsJsonPath: join(this.stateDir, "models.json") });
    (this.models.models as MutableModels).setProvider(this.faux.provider);
  }

  async boot(): Promise<void> {
    this.runtime = createConversationRuntime({
      workspace: this.workspace,
      models: this.models,
      ...runtimeServices(this.stateDir),
      runnerFactory: localRunnerFactory,
    });
    this.socket = new FakeSlackSocket();
    this.bot = new SlackMessagingBot(this.runtime, {
      appToken: "test",
      botToken: "test",
      workspace: this.workspace,
      webApi: fakeSlackWebApi(),
      socket: this.socket,
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      await this.bot.start();
    } finally {
      now.mockRestore();
    }
    const record = async (text: string, thread?: string) => {
      const ts = nextTs();
      this.posts.push({ text, thread, ts, at: performance.now() });
      return ts;
    };
    vi.spyOn(this.bot, "postMessage").mockImplementation(async (_c, text, thread) =>
      record(text, thread),
    );
    vi.spyOn(this.bot, "postInThread").mockImplementation(async (_c, thread, text) =>
      record(text, thread),
    );
    vi.spyOn(this.bot, "updateMessage").mockResolvedValue(undefined);
    vi.spyOn(this.bot, "setAssistantStatus").mockResolvedValue(undefined);
    vi.spyOn(this.bot, "tryReserveStreamStart").mockReturnValue(false);
  }

  async shutdown(): Promise<void> {
    await this.bot.stop();
    await this.runtime.shutdown(5_000);
    vi.restoreAllMocks();
  }

  async dm(text: string): Promise<void> {
    await this.socket.deliver("message", {
      text,
      channel: "D123",
      user: "U1",
      ts: nextTs(),
      channel_type: "im",
    });
  }

  async idle(): Promise<void> {
    await vi.waitFor(() => expect(this.runtime.getRunningSessions()).toHaveLength(0), {
      timeout: 20_000,
    });
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

type Step = Extract<FauxResponseStep, (...a: never[]) => unknown>;
type StepContext = Parameters<Step>[0];
const delegate = (tasks: string[]) =>
  fauxAssistantMessage(
    tasks.map((task, i) => fauxToolCall("subagent", { label: `job ${i}`, task })),
    { stopReason: "toolUse" },
  );
const lastToolResults = (context: StepContext) =>
  context.messages
    .filter((m) => m.role === "toolResult")
    .map((m) => JSON.stringify((m as { content: unknown }).content).slice(0, 160));
async function withWorld(run: (world: World) => Promise<void>, existing?: string): Promise<void> {
  const world = new World(existing);
  try {
    await world.boot();
    await run(world);
  } finally {
    await world.shutdown().catch(() => undefined);
    if (!existing) world.dispose();
  }
}

test("S1 a delegated task returns the child's answer", async () => {
  await withWorld(async (world) => {
    let parentSaw: string[] = [];
    let childSystem = "";
    world.faux.setResponses([
      () => delegate(["count the files"]),
      (context) => {
        const system = context.messages.find((m) => (m as { role: string }).role === "system");
        childSystem = Object.keys(
          (system as { sections?: object } | undefined)?.sections ?? {},
        ).join(",");
        return fauxAssistantMessage("CHILD-ANSWER-42");
      },
      (context) => ((parentSaw = lastToolResults(context)), fauxAssistantMessage("parent final")),
    ]);
    await world.dm("please delegate");
    await vi
      .waitFor(() => expect(world.faux.state.callCount).toBeGreaterThanOrEqual(3), {
        timeout: 20_000,
      })
      .catch(() => undefined);
    await world.idle();
    results.S1 = { parentSaw, childSystem, modelCalls: world.faux.state.callCount };
  });
});

test("S2 a child cannot delegate", async () => {
  await withWorld(async (world) => {
    let childSaw: string[] = [];
    let parentSaw: string[] = [];
    world.faux.setResponses([
      () => delegate(["outer"]),
      () => delegate(["inner"]),
      (context) => ((childSaw = lastToolResults(context)), fauxAssistantMessage("child done")),
      (context) => ((parentSaw = lastToolResults(context)), fauxAssistantMessage("parent final")),
    ]);
    await world.dm("please delegate twice");
    await vi
      .waitFor(() => expect(world.faux.state.callCount).toBeGreaterThanOrEqual(4), {
        timeout: 20_000,
      })
      .catch(() => undefined);
    await world.idle();
    results.S2 = { childSaw, parentSaw, modelCalls: world.faux.state.callCount };
  });
});

test("S3 six tasks at once: how many children run together", async () => {
  await withWorld(async (world) => {
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const child: Step = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight--;
      return fauxAssistantMessage("ok");
    };
    let parentSaw: string[] = [];
    world.faux.setResponses([
      () => delegate(["a", "b", "c", "d", "e", "f"]),
      child,
      child,
      child,
      child,
      child,
      child,
      (context) => ((parentSaw = lastToolResults(context)), fauxAssistantMessage("parent final")),
    ]);
    await world.dm("six please");
    await vi
      .waitFor(() => expect(inFlight).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    const peakWhileHeld = peak;
    release();
    await vi
      .waitFor(() => expect(parentSaw.length).toBeGreaterThan(0), { timeout: 20_000 })
      .catch(() => undefined);
    await world.idle();
    results.S3 = { peakWhileHeld, answers: parentSaw.length };
  });
});

test("S4 stop while a child is working", async () => {
  await withWorld(async (world) => {
    let started = false;
    world.faux.setResponses([
      () => delegate(["long job"]),
      async (_context, options) => {
        started = true;
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return fauxAssistantMessage("late child answer");
      },
      () => fauxAssistantMessage("parent continued after stop"),
      () => fauxAssistantMessage("extra call"),
    ]);
    await world.dm("start something long");
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 10_000 }).catch(() => undefined);
    const calls = world.faux.state.callCount;
    const sent = performance.now();
    await world.dm("stop");
    await world.idle().catch(() => undefined);
    const ms = Math.round(performance.now() - sent);
    await new Promise((r) => setTimeout(r, 300));
    results.S4 = {
      childStarted: started,
      idleAfterStop: world.runtime.getRunningSessions().length === 0,
      msToIdle: ms,
      modelCallsAfterStop: world.faux.state.callCount - calls,
      posts: world.posts.map((p) => p.text.slice(0, 40)),
    };
  });
});

test("S5 the child's model spend reaches the usage summary", async () => {
  await withWorld(async (world) => {
    vi.spyOn(log, "logUsageSummary");
    world.faux.setResponses([
      () => delegate(["count"]),
      () => fauxAssistantMessage("x".repeat(4000)),
      () => fauxAssistantMessage("parent final"),
    ]);
    await world.dm("please delegate");
    await vi
      .waitFor(() => expect(world.faux.state.callCount).toBeGreaterThanOrEqual(3), {
        timeout: 20_000,
      })
      .catch(() => undefined);
    await world.idle();
    const usage = vi.mocked(log.logUsageSummary).mock.calls.at(-1)?.[1];
    results.S5 = { outputTokens: usage?.output ?? null, totalTokens: usage?.totalTokens ?? null };
  });
});

test("S6 sessions listed for the office after a delegated run", async () => {
  await withWorld(async (world) => {
    world.faux.setResponses([
      () => delegate(["count"]),
      () => fauxAssistantMessage("child"),
      () => fauxAssistantMessage("parent final"),
    ]);
    await world.dm("please delegate");
    await vi
      .waitFor(() => expect(world.faux.state.callCount).toBeGreaterThanOrEqual(3), {
        timeout: 20_000,
      })
      .catch(() => undefined);
    await world.idle();
    const office = world.workspace.office(createOfficeAddress("slack", "D123"));
    const sessions = await SessionStore.list(office);
    results.S6 = { sessions: sessions.map((s) => s.key) };
  });
});
