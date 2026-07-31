import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import activate from "../../deploy/examples/extensions/agent-pm/src/index.js";
import { insertEvent } from "../../deploy/examples/extensions/agent-pm/src/store.js";
import { taipeiDate, weekdayOf } from "../../deploy/examples/extensions/agent-pm/src/clock.js";

/**
 * The `agent-pm` example, driven end to end against a stub api.
 *
 * The example is referenced from the extension docs as the reference
 * implementation, so it has to keep working as the extension API moves — a
 * broken example is worse than none, because it is what people copy. This
 * covers the pipeline itself; `e2e/slack/agent-pm.e2e.ts` covers the seam to
 * a real platform.
 */

/**
 * A heartbeat hour that is deliberately not the current one, so the real clock
 * tick can never match and the synthesized tick is the only trigger. Without
 * this the assertions pass or fail depending on the wall clock.
 */
const CURRENT_HOUR = Number(
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    hour12: false,
  }).format(new Date()),
);
const HEARTBEAT_HOUR = (CURRENT_HOUR + 5) % 24;

interface Post {
  text: string;
  conversationId?: string;
  threadTs?: string;
}

function createHarness(dataDir: string) {
  const posts: Post[] = [];
  const callbacks = new Map<string, (event: { scheduleName: string }) => Promise<void>>();
  const commands = new Map<
    string,
    (context: { args: string; respond: (t: string) => void }) => Promise<void>
  >();
  const schedules: Array<{ name: string; spec: Record<string, unknown> }> = [];
  const tools: string[] = [];
  const logs: string[] = [];
  const disposers: Array<() => void> = [];

  const api = {
    context: { conversationId: "C_CONTROL", workspaceDir: "/tmp", model: {}, thinkingLevel: "off" },
    paths: { dataDir, sharedDataDir: dataDir },
    log: (message: string) => logs.push(message),
    onDispose: (fn: () => void) => disposers.push(fn),
    registerCommand: (command: { name: string; handler: never }) =>
      commands.set(command.name, command.handler),
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    on: () => {},
    schedules: {
      onCallback: (name: string, handler: never) => callbacks.set(name, handler),
      upsert: async (name: string, spec: Record<string, unknown>) =>
        void schedules.push({ name, spec }),
      delete: async () => false,
      list: async () => [],
    },
    notify: async (text: string, options?: { conversationId?: string; threadTs?: string }) => {
      posts.push({ text, ...options });
      return `170000000${posts.length}.0001`;
    },
    subagent: { run: async () => ({ status: "completed", output: {} }) },
    secrets: { get: () => undefined, list: () => [] },
  };

  return { api, posts, callbacks, commands, schedules, tools, logs, disposers };
}

function writeConfig(dataDir: string): void {
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({
      controlConversationId: "C_CONTROL",
      deliveryMode: "test",
      testConversationId: "C_QA",
      githubOrg: "",
      calendarId: "",
      disabledSources: [],
      heartbeatHour: HEARTBEAT_HOUR,
      scheduleOverrides: {},
    }),
  );
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "agent-pm-example-"));
  writeConfig(dataDir);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** Add a clock tick at the configured heartbeat hour, as ingest would. */
function synthesizeHeartbeatTick(db: DatabaseSync, suffix: string): void {
  const date = taipeiDate();
  insertEvent(db, {
    sourceKey: "clock",
    externalId: `${date}T${HEARTBEAT_HOUR}-${suffix}`,
    kind: "clock.tick",
    subject: "system:clock",
    actorRole: "system",
    title: "synthetic tick",
    payload: { date, hour: HEARTBEAT_HOUR, weekday: weekdayOf(date), isSendDay: true },
  });
}

describe("agent-pm example extension", () => {
  test("activate registers callback schedules, a tool, and the /pm command", async () => {
    const harness = createHarness(dataDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub api
    await activate(harness.api as any);

    expect(harness.schedules.map((entry) => entry.name)).toEqual([
      "ingest-events",
      "run-workflows",
      "sweep-tasks",
    ]);
    // Callback specs, not text: these fire host-side code, never an agent run.
    for (const entry of harness.schedules) {
      expect(entry.spec.callback).toBeTypeOf("string");
      expect(entry.spec.text).toBeUndefined();
    }
    expect(harness.tools).toEqual(["pm_task"]);
    expect(harness.commands.has("pm")).toBe(true);
  });

  test("schedules stay unregistered until a conversation is named as owner", async () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ deliveryMode: "test" }));
    const harness = createHarness(dataDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub api
    await activate(harness.api as any);

    // Otherwise every conversation the extension is installed in would register
    // its own copy of the daily jobs.
    expect(harness.schedules).toHaveLength(0);
    expect(harness.logs.join("\n")).toContain("no controlConversationId set");
  });

  test("ingest is idempotent within the hour", async () => {
    const harness = createHarness(dataDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub api
    await activate(harness.api as any);

    await harness.callbacks.get("ingest-events")!({ scheduleName: "ingest-events" });
    await harness.callbacks.get("ingest-events")!({ scheduleName: "ingest-events" });

    const db = new DatabaseSync(join(dataDir, "agent-pm.db"));
    const ticks = db.prepare("SELECT * FROM events WHERE kind = 'clock.tick'").all();
    db.close();
    // The hour bucket is the external id, so ingest running every ten minutes
    // still cannot double-fire a daily job.
    expect(ticks).toHaveLength(1);
  });

  test("an event matching no workflow is recorded, not dropped", async () => {
    const harness = createHarness(dataDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub api
    await activate(harness.api as any);
    await harness.callbacks.get("ingest-events")!({ scheduleName: "ingest-events" });
    await harness.callbacks.get("run-workflows")!({ scheduleName: "run-workflows" });

    const db = new DatabaseSync(join(dataDir, "agent-pm.db"));
    const event = db.prepare("SELECT state, state_reason FROM events LIMIT 1").get() as {
      state: string;
      state_reason: string;
    };
    db.close();
    // A routing gap and a quiet day are indistinguishable otherwise.
    expect(event.state).toBe("skipped");
    expect(event.state_reason).toBe("no workflow matched");
  });

  test("a matching tick delivers the heartbeat, diverted and attributed", async () => {
    const harness = createHarness(dataDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub api
    await activate(harness.api as any);

    const db = new DatabaseSync(join(dataDir, "agent-pm.db"));
    synthesizeHeartbeatTick(db, "first");
    await harness.callbacks.get("run-workflows")!({ scheduleName: "run-workflows" });

    expect(harness.posts).toHaveLength(1);
    const post = harness.posts[0]!;
    // Test mode must divert, and say where it would have gone.
    expect(post.conversationId).toBe("C_QA");
    expect(post.text.startsWith("_[agent-pm test → C_CONTROL]_")).toBe(true);

    const run = db.prepare("SELECT * FROM workflow_runs ORDER BY id DESC LIMIT 1").get() as {
      status: string;
      workflow_version_id: number | null;
    };
    expect(run.status).toBe("succeeded");
    // Without a version to point at, the run's attribution is meaningless and
    // no feedback about it could ever be aimed at a prompt.
    expect(run.workflow_version_id).not.toBeNull();

    const delivery = db.prepare("SELECT * FROM deliveries").get() as {
      status: string;
      external_ref: string;
      dedupe_key: string;
    };
    expect(delivery.status).toBe("sent");
    expect(delivery.external_ref).not.toBe("");
    expect(delivery.dedupe_key).toBe(`heartbeat:${taipeiDate()}`);
    db.close();
  });

  test("with no hour pinned, the heartbeat lands on the first tick of the day", async () => {
    // The default, and what a deployment gets unless it asks otherwise: the
    // heartbeat answers "is the pipeline alive", so it delivers as soon as it
    // is, rather than only if it happened to be alive at one chosen hour.
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        controlConversationId: "C_CONTROL",
        deliveryMode: "test",
        testConversationId: "C_QA",
      }),
    );
    const harness = createHarness(dataDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub api
    await activate(harness.api as any);

    await harness.callbacks.get("ingest-events")!({ scheduleName: "ingest-events" });
    await harness.callbacks.get("run-workflows")!({ scheduleName: "run-workflows" });
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]!.text).toContain("events pending");

    // Still daily: the per-day delivery key is what makes it so, not the hour.
    const db = new DatabaseSync(join(dataDir, "agent-pm.db"));
    synthesizeHeartbeatTick(db, "later-same-day");
    db.close();
    await harness.callbacks.get("run-workflows")!({ scheduleName: "run-workflows" });
    expect(harness.posts).toHaveLength(1);
  });

  test("a second matching tick the same day delivers nothing", async () => {
    const harness = createHarness(dataDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub api
    await activate(harness.api as any);

    const db = new DatabaseSync(join(dataDir, "agent-pm.db"));
    synthesizeHeartbeatTick(db, "first");
    await harness.callbacks.get("run-workflows")!({ scheduleName: "run-workflows" });
    synthesizeHeartbeatTick(db, "second");
    await harness.callbacks.get("run-workflows")!({ scheduleName: "run-workflows" });

    // The dedupe key is a unique index, so suppression does not depend on any
    // caller remembering to check first.
    expect(harness.posts).toHaveLength(1);
    const count = db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  test("/pm reports status and runs stages on demand", async () => {
    const harness = createHarness(dataDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub api
    await activate(harness.api as any);

    let replied = "";
    const respond = async (text: string) => void (replied = text);
    const pm = harness.commands.get("pm")!;

    await pm({ args: "status", respond } as never);
    expect(replied).toContain("delivery: `test`");
    expect(replied).toContain("schedules owned by: this conversation");

    await pm({ args: "all", respond } as never);
    expect(replied).toMatch(/ingest: \d+ new event/);
    expect(replied).toMatch(/run: \d+ processed/);
    expect(replied).toMatch(/sweep: \d+ overdue/);

    await pm({ args: "nonsense", respond } as never);
    expect(replied).toContain("Unknown action");
  });

  test("pm_task closes a task and records existence feedback when it should not have existed", async () => {
    const harness = createHarness(dataDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub api
    await activate(harness.api as any);

    const db = new DatabaseSync(join(dataDir, "agent-pm.db"));
    db.prepare(
      "INSERT INTO tasks (title, opened_at, queue) VALUES ('review the thing', ?, 'inbox')",
    ).run(new Date().toISOString());
    db.close();

    // The tool is registered on the stub, so reach it the way the agent would:
    // re-activate with a capturing registerTool.
    let execute: ((id: string, params: unknown) => Promise<unknown>) | undefined;
    const capturing = createHarness(dataDir);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub api
    (capturing.api as any).registerTool = (tool: {
      name: string;
      execute: (id: string, params: unknown) => Promise<unknown>;
    }) => {
      if (tool.name === "pm_task") execute = tool.execute;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stub api
    await activate(capturing.api as any);
    expect(execute).toBeDefined();

    const listed = (await execute!("t1", { action: "list" })) as {
      content: { text: string }[];
      details: { count: number };
    };
    expect(listed.details.count).toBe(1);
    expect(listed.content[0]!.text).toContain("review the thing");

    await execute!("t2", { action: "close", id: 1, outcome: "no_action_needed", note: "noise" });

    const after = new DatabaseSync(join(dataDir, "agent-pm.db"));
    const task = after.prepare("SELECT status, outcome FROM tasks WHERE id = 1").get() as {
      status: string;
      outcome: string;
    };
    expect(task).toEqual({ status: "done", outcome: "no_action_needed" });

    // Closing as noise IS the feedback — asking a second time in a form is how
    // feedback loops end up with no data in them.
    const feedback = after.prepare("SELECT dimension, verdict, capture FROM feedback").get() as {
      dimension: string;
      verdict: string;
      capture: string;
    };
    expect(feedback).toEqual({ dimension: "existence", verdict: "wrong", capture: "implicit" });
    after.close();
  });
});
