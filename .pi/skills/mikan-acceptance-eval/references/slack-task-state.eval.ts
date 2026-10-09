import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { Type, type TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
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
import { JevNotConfiguredError } from "@mikan/harness/jev.js";
import { createConversationRuntime } from "@mikan/runtime/conversation-runtime.js";
import { SlackMessagingBot } from "@mikan/adapters/slack/bot.js";
import { SessionStore } from "@mikan/sessions/session-store.js";
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
void JevNotConfiguredError;

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

class World {
  readonly dir: string;
  readonly stateDir: string;
  readonly workspace;
  readonly models;
  readonly faux = fauxProvider();
  posts: Post[] = [];
  toolStarts = 0;
  hold = deferred();
  runtime!: ReturnType<typeof createConversationRuntime>;
  bot!: SlackMessagingBot;
  socket!: FakeSlackSocket;

  constructor(existing?: string) {
    this.dir = existing ?? mkdtempSync(join(tmpdir(), "mikan-task-eval-"));
    this.stateDir = join(this.dir, "state");
    if (!existing) this.writeSettings();
    this.workspace = createWorkspace({ root: this.dir, stateDir: this.stateDir });
    this.models = MikanModels.create({ modelsJsonPath: join(this.stateDir, "models.json") });
    (this.models.models as MutableModels).setProvider(this.faux.provider);
  }

  private writeSettings(): void {
    mkdirSync(this.stateDir);
    createGlobalSettingsFile(this.stateDir);
    writeFileSync(
      join(this.stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" },
        sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
      }),
    );
  }

  get office() {
    return this.workspace.office(createOfficeAddress("slack", "D123"));
  }

  async boot(): Promise<void> {
    const tool: AgentTool<TSchema> = {
      name: "hold",
      label: "hold",
      description: "Controlled long-running operation",
      parameters: Type.Object({}),
      execute: async (_id, _args, signal) => {
        this.toolStarts++;
        const cancel = () => this.hold.resolve();
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          await this.hold.promise;
        } finally {
          signal?.removeEventListener("abort", cancel);
        }
        return { content: [{ type: "text", text: "operation finished" }], details: {} };
      },
    };
    this.runtime = createConversationRuntime({
      workspace: this.workspace,
      sandbox: { type: "host" },
      models: this.models,
      platformToolPackFactories: [() => ({ tools: [tool], bindRun: () => {} })],
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

  async dm(text: string, thread?: string): Promise<void> {
    await this.socket.deliver("message", {
      text,
      channel: "D123",
      user: "U1",
      ts: nextTs(),
      thread_ts: thread,
      channel_type: "im",
    });
  }

  running(): string[] {
    return this.runtime.getRunningSessions().map((s) => s.sessionKey);
  }

  async idle(): Promise<void> {
    await vi.waitFor(() => expect(this.running()).toHaveLength(0), { timeout: 10_000 });
  }

  rootOf(ack: string): string {
    const post = this.posts.find((p) => p.text === ack && !p.thread);
    if (!post) throw new Error(`no task root posted for ${ack}`);
    return post.ts;
  }

  async startTask(ack: string, after: FauxResponseStep[] = []): Promise<string> {
    const starts = this.toolStarts;
    this.hold = deferred();
    this.faux.setResponses([handoff(ack), callHold(), ...after]);
    await this.dm(`please do ${ack}`);
    await vi.waitFor(() => expect(this.toolStarts).toBe(starts + 1), { timeout: 10_000 });
    return this.rootOf(ack);
  }

  async taskStatus(): Promise<TaskRow[]> {
    let observed: string | undefined;
    this.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("task_status", {}), { stopReason: "toolUse" }),
      (context) => {
        const result = context.messages.findLast(
          (m) => m.role === "toolResult" && m.toolName === "task_status",
        );
        observed =
          result && Array.isArray(result.content)
            ? result.content.map((p) => (p.type === "text" ? p.text : "")).join("")
            : "";
        return fauxAssistantMessage("noted");
      },
    ]);
    await this.dm("check on my background work please");
    await vi.waitFor(() => expect(observed).toBeDefined(), { timeout: 10_000 });
    try {
      const parsed: unknown = JSON.parse(observed!);
      return Array.isArray(parsed) ? (parsed as TaskRow[]) : [];
    } catch {
      return [{ status: `unparsed: ${observed!.slice(0, 80)}` }];
    }
  }

  async threadStatusShortcut(
    root: string,
  ): Promise<{ replied: boolean; ms?: number; text?: string; modelCalls: number }> {
    const calls = this.faux.state.callCount;
    const before = this.posts.length;
    const sent = performance.now();
    this.faux.setResponses([fauxAssistantMessage("model answered")]);
    await this.dm("好了嗎？", root);
    const reply = await vi
      .waitFor(
        () => {
          const post = this.posts.slice(before).find((p) => p.thread === root);
          expect(post).toBeDefined();
          return post!;
        },
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 200));
    return {
      replied: reply !== undefined && this.faux.state.callCount === calls,
      ms: reply ? Math.round(reply.at - sent) : undefined,
      text: reply?.text.slice(0, 40),
      modelCalls: this.faux.state.callCount - calls,
    };
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

interface TaskRow {
  sessionKey?: string;
  acknowledgement?: string;
  status?: string;
}

const handoff = (ack: string) =>
  fauxAssistantMessage(fauxToolCall("start_task", { message: ack, task: `Brief for ${ack}` }), {
    stopReason: "toolUse",
  });
const callHold = () => fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" });
const answer = (text: string) => fauxAssistantMessage(text);

function summarize(rows: TaskRow[], expected: Record<string, string>) {
  const byAck = new Map(rows.map((r) => [r.acknowledgement, r.status]));
  const tasks = Object.fromEntries(
    Object.entries(expected).map(([ack, want]) => [
      ack,
      { found: byAck.has(ack), status: byAck.get(ack) ?? null, expected: want },
    ]),
  );
  const correct = Object.entries(expected).filter(([ack, want]) => byAck.get(ack) === want).length;
  return { listed: rows.length, correct: `${correct}/${Object.keys(expected).length}`, tasks };
}

test("E1-E4: three tasks, restart, thread status, lost log", async () => {
  const world = new World();
  try {
    await world.boot();
    await world.startTask("ACK-A", [answer("A done")]);
    world.hold.resolve();
    await world.idle();
    const rootB = await world.startTask("ACK-B");
    await world.dm("stop", rootB);
    await world.idle();
    await world.startTask("ACK-C", []);
    const live = await world.taskStatus();
    results.E1_status_while_one_runs = summarize(live, {
      "ACK-A": "completed",
      "ACK-B": "aborted",
      "ACK-C": "running",
    });
    world.faux.setResponses([answer("C done")]);
    world.hold.resolve();
    await world.idle();

    await world.shutdown();
    await world.boot();
    const afterRestart = await world.taskStatus();
    results.E2_status_after_restart = summarize(afterRestart, {
      "ACK-A": "completed",
      "ACK-B": "aborted",
      "ACK-C": "completed",
    });
    results.E3_thread_status_shortcut = await world.threadStatusShortcut(world.rootOf("ACK-A"));

    const rootA = world.rootOf("ACK-A");
    await world.shutdown();
    renameSync(world.office.logPath, `${world.office.logPath}.lost`);
    await world.boot();
    const afterLogLoss = await world.taskStatus();
    results.E4_status_after_log_loss = summarize(afterLogLoss, {
      "ACK-A": "completed",
      "ACK-B": "aborted",
      "ACK-C": "completed",
    });
    results.E4_thread_shortcut_after_log_loss = await world.threadStatusShortcut(rootA);
    await world.shutdown();
  } finally {
    world.dispose();
  }
});

test("E5: a task thread from 1.0.x (ownerless session, taskRoot in the log)", async () => {
  const world = new World();
  try {
    const office = world.office;
    office.ensure();
    const root = `${Math.floor(Date.now() / 1000) - 3600}.000001`;
    appendFileSync(
      office.logPath,
      `${JSON.stringify({ date: new Date().toISOString(), ts: root, user: "bot", text: "ACK-LEGACY", isMessagingBot: true, taskRoot: true })}\n`,
    );
    await (await SessionStore.open(office, "D123")).close();
    const legacy = await SessionStore.open(office, `D123:${root}`);
    await legacy.recordRun({ endedAt: Date.now(), status: "completed" });
    await legacy.close();
    await world.boot();
    results.E5_legacy_status = summarize(await world.taskStatus(), { "ACK-LEGACY": "completed" });
    results.E5_legacy_thread_shortcut = await world.threadStatusShortcut(root);
    await world.shutdown();
  } finally {
    world.dispose();
  }
});

test("E6: thread status latency with a 50 MB office log", async () => {
  const world = new World();
  try {
    await world.boot();
    await world.startTask("ACK-BIG", [answer("done")]);
    world.hold.resolve();
    await world.idle();
    const root = world.rootOf("ACK-BIG");
    const filler = `${JSON.stringify({ date: new Date().toISOString(), ts: "1.000001", user: "U1", text: "x".repeat(900), isMessagingBot: false })}\n`;
    const chunk = filler.repeat(1000);
    for (let i = 0; i < 55; i++) appendFileSync(world.office.logPath, chunk);
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await world.threadStatusShortcut(root);
      if (r.ms !== undefined) samples.push(r.ms);
    }
    samples.sort((a, b) => a - b);
    results.E6_thread_status_ms_50mb_log = { median: samples[2] ?? null, samples };
    await world.shutdown();
  } finally {
    world.dispose();
  }
});

test("E7: tasks created by one checkout, read by another (upgrade)", async () => {
  const stateRoot = process.env.EVAL_UPGRADE_DIR;
  const phase = process.env.EVAL_UPGRADE_PHASE;
  if (!stateRoot || !phase) return;
  if (phase === "create") {
    rmSync(stateRoot, { recursive: true, force: true });
    const world = new World();
    await world.boot();
    await world.startTask("ACK-OLD-A", [answer("A done")]);
    world.hold.resolve();
    await world.idle();
    const rootB = await world.startTask("ACK-OLD-B");
    await world.dm("stop", rootB);
    await world.idle();
    await world.shutdown();
    writeFileSync(
      join(world.dir, "roots.json"),
      JSON.stringify({ A: world.rootOf("ACK-OLD-A"), B: rootB }),
    );
    renameSync(world.dir, stateRoot);
    return;
  }
  const reopened = new World(stateRoot);
  await reopened.boot();
  const roots = JSON.parse(readFileSync(join(stateRoot, "roots.json"), "utf8")) as {
    A: string;
    B: string;
  };
  const rows = await reopened.taskStatus();
  const byKey = new Map(rows.map((r) => [r.sessionKey, r]));
  const expected = { A: "completed", B: "aborted" } as const;
  results.E7_upgrade_status = Object.fromEntries(
    (["A", "B"] as const).map((name) => {
      const row = byKey.get(`D123:${roots[name]}`);
      return [
        `ACK-OLD-${name}`,
        {
          found: row !== undefined,
          statusCorrect: row?.status === expected[name],
          acknowledgement: row?.acknowledgement ?? null,
        },
      ];
    }),
  );
  results.E7_upgrade_thread_shortcut = await reopened.threadStatusShortcut(roots.A);
  await reopened.shutdown();
});
