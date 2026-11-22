import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { JsonValue } from "@earendil-works/chord/json";
import { err, ExecutionError, ok, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BackgroundJobs, type BackgroundJobSink } from "../events/jobs.js";
import { createBashBackgroundTool } from "../harness/tools/bash-background.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office, Workspace } from "../office/types.js";
import type { ConversationEvent, MessagingBot } from "../types.js";
import { runTestTool, TEST_CONTEXT } from "./tool-api.js";

let dir: string;
let workspace: Workspace;
let office: Office;

beforeEach(() => {
  dir = mkdtempSync(join(homedir(), ".mikan-bash-background-test-"));
  mkdirSync(join(dir, "workspace"));
  workspace = createWorkspace({ root: join(dir, "workspace"), stateDir: join(dir, "state") });
  office = workspace.office(createOfficeAddress("slack", "D1"));
  office.ensure();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RUN = {
  sessionKey: "D1:100.1",
  threadTs: "100.1",
  userId: "U1",
  conversationKind: "direct" as const,
  runtimeWorkspaceRoot: "/workspace",
};

function fakeEnv(exitCode: number | ExecutionError, output = "") {
  const exec = vi.fn<ExecutionEnv["exec"]>(async (_command, options) => {
    if (exitCode instanceof ExecutionError) return err(exitCode);
    if (output) options?.onOutput?.(output, TEST_CONTEXT, { stream: "stderr" });
    return ok({ exitCode });
  });
  return { exec, env: { exec } as Pick<ExecutionEnv, "exec"> as ExecutionEnv };
}

function sink() {
  return { register: vi.fn(), forget: vi.fn() } satisfies BackgroundJobSink;
}

function tool(
  env: ExecutionEnv | undefined,
  jobs: BackgroundJobSink,
  run: typeof RUN | null = RUN,
) {
  const created = createBashBackgroundTool({ env: () => env }, jobs, office);
  if (run) created.setRunContext(run);
  return created.tool;
}

const text = (result: Awaited<ReturnType<typeof runTestTool>>) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("");

describe("bash_background", () => {
  test("records the job for its session, then starts the wrapper, and returns the ID and paths", async () => {
    const { env, exec } = fakeEnv(0);
    const jobs = sink();
    jobs.register.mockImplementation(() => expect(exec).not.toHaveBeenCalled());

    const result = await runTestTool(
      tool(env, jobs),
      { label: "tests", command: "npm test" },
      { memos: new Map() },
    );

    const { id } = jobs.register.mock.calls[0]![1];
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    const guestDir = `/workspace/${office.key}/.jobs/${id}`;
    expect(jobs.register).toHaveBeenCalledExactlyOnceWith(office, {
      id,
      command: "npm test",
      label: "tests",
      sessionKey: "D1:100.1",
      threadTs: "100.1",
      userId: "U1",
      conversationKind: "direct",
      guestDir,
    });
    const [script, options] = exec.mock.calls[0]!;
    expect(options?.env).toEqual({ MIKAN_JOB_DIR: guestDir, MIKAN_JOB_CMD: "npm test" });
    expect(script).not.toContain("npm test");
    expect(script).toContain("setsid");
    expect(text(result)).toContain(`Started job ${id}.`);
    expect(text(result)).toContain(`log: ${guestDir}/log`);
    expect(text(result)).toContain(`${guestDir}/exit`);
    expect(text(result)).toContain(`kill -- -$(cat ${guestDir}/pid)`);
    expect(jobs.forget).not.toHaveBeenCalled();
  });

  test("a replayed call keeps its job ID and reports the job it already started", async () => {
    const jobs = sink();
    const memos = new Map<string, JsonValue>();
    const first = await runTestTool(
      tool(fakeEnv(0).env, jobs),
      { label: "x", command: "c" },
      { memos },
    );
    const replay = await runTestTool(
      tool(fakeEnv(97).env, jobs),
      { label: "x", command: "c" },
      { memos },
    );

    expect(jobs.register.mock.calls[1]![1].id).toBe(jobs.register.mock.calls[0]![1].id);
    expect(text(replay)).toBe(text(first));
    expect(jobs.forget).not.toHaveBeenCalled();
  });

  test("says so when the sandbox has no setsid, and drops the record", async () => {
    const jobs = sink();
    await expect(
      runTestTool(tool(fakeEnv(96).env, jobs), { label: "x", command: "c" }, { memos: new Map() }),
    ).rejects.toThrow(/no `setsid` command/);
    expect(jobs.forget).toHaveBeenCalledExactlyOnceWith(office, jobs.register.mock.calls[0]![1].id);
  });

  test("reports a start that failed with what the shell printed", async () => {
    const jobs = sink();
    await expect(
      runTestTool(
        tool(fakeEnv(98, "mkdir: Read-only file system").env, jobs),
        { label: "x", command: "c" },
        { memos: new Map() },
      ),
    ).rejects.toThrow(/could not be started \(exit 98\): mkdir: Read-only file system/);
    expect(jobs.forget).toHaveBeenCalledTimes(1);
  });

  test("keeps the record when the start cannot be confirmed, so a started job is still reported", async () => {
    const jobs = sink();
    await expect(
      runTestTool(
        tool(fakeEnv(new ExecutionError("unknown", "connection closed")).env, jobs),
        { label: "x", command: "c" },
        { memos: new Map() },
      ),
    ).rejects.toThrow(/could not be confirmed \(connection closed\)/);
    expect(jobs.register).toHaveBeenCalledTimes(1);
    expect(jobs.forget).not.toHaveBeenCalled();
  });

  test("is unavailable without an execution environment or outside a run", async () => {
    const jobs = sink();
    const args = { label: "x", command: "c" };
    await expect(runTestTool(tool(undefined, jobs), args, { memos: new Map() })).rejects.toThrow(
      /unavailable here/,
    );
    await expect(
      runTestTool(tool(fakeEnv(0).env, jobs, null), args, { memos: new Map() }),
    ).rejects.toThrow(/unavailable here/);
    expect(jobs.register).not.toHaveBeenCalled();
  });

  test("its description states the limits the model has to plan around", () => {
    const { description } = tool(undefined, sink());
    expect(description).toContain("killed after 2h 0m");
    expect(description).toContain("`stop`");
    expect(description).toContain("`/new`");
    expect(description).toContain("naming the log file");
  });
});

const hasSetsid = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;

describe.runIf(hasSetsid)("bash_background on a local shell", () => {
  function local() {
    const enqueueEvent = vi.fn<(event: ConversationEvent) => boolean>().mockReturnValue(true);
    const bot = { enqueueEvent } as Pick<MessagingBot, "enqueueEvent"> as MessagingBot;
    const jobs = new BackgroundJobs(workspace, { slack: bot });
    const env = new NodeExecutionEnv({ cwd: workspace.root });
    const created = createBashBackgroundTool({ env: () => env }, jobs, office);
    created.setRunContext({ ...RUN, runtimeWorkspaceRoot: workspace.root });
    const notice = async () => {
      await vi.waitFor(
        async () => {
          jobs.poll();
          expect(enqueueEvent).toHaveBeenCalled();
        },
        { timeout: 10_000, interval: 50 },
      );
      return enqueueEvent.mock.calls[0]![0];
    };
    return { tool: created.tool, jobs, enqueueEvent, notice };
  }
  const only = () => join(office.dir, ".jobs", readdirSync(join(office.dir, ".jobs"))[0]!);

  test("a job outlives the call, and its exit code reaches the owning session with the log's path", async () => {
    const { tool: started, notice } = local();
    const result = await runTestTool(
      started,
      { label: "x", command: "echo out; echo err >&2; exit 7" },
      { memos: new Map() },
    );

    const event = await notice();
    expect(text(result)).toContain(`log: ${only()}/log`);
    expect(event).toMatchObject({ sessionKey: "D1:100.1", thread_ts: "100.1" });
    expect(event.text).toBe(
      `${/^\[job \w+ exited 7 after \d+s\] echo out; echo err >&2; exit 7$/m.exec(event.text)?.[0]}\nIts output is in ${only()}/log; read it with bash.`,
    );
    expect(readFileSync(join(only(), "log"), "utf8")).toBe("out\nerr\n");
    expect(readFileSync(join(only(), "exit"), "utf8").trim()).toBe("7");
  });

  test("a replayed call does not start the command a second time", async () => {
    const { tool: started, notice, enqueueEvent, jobs } = local();
    const marker = join(dir, "starts");
    const args = { label: "x", command: `echo started >> ${marker}` };
    const memos = new Map<string, JsonValue>();
    await runTestTool(started, args, { memos });
    await notice();
    await runTestTool(started, args, { memos });
    jobs.poll();

    expect(readFileSync(marker, "utf8")).toBe("started\n");
    expect(readdirSync(join(office.dir, ".jobs"))).toHaveLength(1);
    expect(enqueueEvent).toHaveBeenCalledTimes(1);
  });

  test("killing the job's process group ends its children and is reported as exit 143", async () => {
    const { tool: started, notice } = local();
    await runTestTool(
      started,
      { label: "x", command: "sleep 300 & sleep 301" },
      { memos: new Map() },
    );
    const group = await vi.waitFor(() => {
      const pid = existsSync(join(only(), "pid")) ? readFileSync(join(only(), "pid"), "utf8") : "";
      expect(pid).toMatch(/^\d+\n$/);
      return pid.trim();
    });

    expect(spawnSync("sh", ["-c", `kill -- -${group}`]).status).toBe(0);

    expect((await notice()).text).toMatch(/^\[job \w+ exited 143 /);
    expect(spawnSync("sh", ["-c", `kill -0 -- -${group}`]).status).not.toBe(0);
  });
});
