import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BackgroundJobs,
  isJobRunId,
  jobRunId,
  type BackgroundJobStart,
  type JobContainers,
} from "../events/jobs.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import type { ConversationEvent, MessagingBot } from "../types.js";

let dir: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-background-jobs-"));
  mkdirSync(join(dir, "workspace"));
  now = 1_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function office(conversationId = "D1"): Office {
  const value = createWorkspace({
    root: join(dir, "workspace"),
    stateDir: join(dir, "state"),
  }).office(createOfficeAddress("slack", conversationId));
  value.ensure();
  return value;
}

function world(options: { limitMs?: number } = {}) {
  const enqueueEvent = vi.fn<(event: ConversationEvent) => boolean>().mockReturnValue(true);
  const bot: MessagingBot = {
    start: async () => {},
    stop: async () => {},
    postMessage: async () => "1",
    updateMessage: async () => {},
    enqueueEvent,
    conversationKindOf: () => "shared",
    getMessagingInfo: () => ({ name: "slack", formattingGuide: "", channels: [], users: [] }),
  };
  const released: string[] = [];
  const containers = {
    retain: vi.fn((key: string) => () => void released.push(key)),
    exec: vi.fn(async () => ({ stdout: "" })),
  } satisfies JobContainers;
  const jobs = new BackgroundJobs(
    createWorkspace({ root: join(dir, "workspace"), stateDir: join(dir, "state") }),
    { slack: bot },
    { containers, limitMs: options.limitMs, now: () => now },
  );
  return { jobs, enqueueEvent, containers, released };
}

function start(own: Office, id: string, overrides: Partial<BackgroundJobStart> = {}) {
  return {
    id,
    command: "npm test",
    label: "tests",
    sessionKey: own.address.conversationId,
    threadTs: undefined,
    userId: "U1",
    conversationKind: "direct" as const,
    guestDir: `/workspace/${own.key}/.jobs/${id}`,
    ...overrides,
  };
}

function jobDir(own: Office, id: string): string {
  const path = join(own.dir, ".jobs", id);
  mkdirSync(path, { recursive: true });
  return path;
}

function finish(own: Office, id: string, exitCode: number, log = "", endedAt = now): void {
  const path = jobDir(own, id);
  writeFileSync(join(path, "log"), log);
  writeFileSync(join(path, "exit"), `${exitCode}\n`);
  utimesSync(join(path, "exit"), endedAt / 1000, endedAt / 1000);
}

const records = (own: Office) =>
  JSON.parse(readFileSync(join(own.stateDir, "jobs.json"), "utf8")).jobs as Array<
    Record<string, unknown>
  >;

describe("job notice IDs", () => {
  test("are told apart from message and scheduled-event IDs", () => {
    expect(jobRunId("ab12")).toBe("job:ab12");
    expect(isJobRunId("job:ab12")).toBe(true);
    expect(isJobRunId("event:reminder")).toBe(false);
    expect(isJobRunId("1700000000.000100")).toBe(false);
  });
});

describe("BackgroundJobs", () => {
  test("keeps its record in the office's state directory, private, and retains the container", () => {
    const own = office();
    const { jobs, containers } = world();
    jobs.register(own, start(own, "a1"));

    const path = join(own.stateDir, "jobs.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(records(own)).toEqual([
      expect.objectContaining({ id: "a1", sessionKey: "D1", startedAt: now, delivered: false }),
    ]);
    expect(containers.retain).toHaveBeenCalledExactlyOnceWith(own.key);
  });

  test("a registration repeated with the same ID changes nothing", () => {
    const own = office();
    const { jobs, containers } = world();
    jobs.register(own, start(own, "a1"));
    now += 5000;
    jobs.register(own, start(own, "a1", { command: "other" }));

    expect(records(own)).toEqual([expect.objectContaining({ command: "npm test" })]);
    expect(containers.retain).toHaveBeenCalledTimes(1);
  });

  test("delivers one notice into the owning session when the exit file appears", async () => {
    const own = office("C1");
    const { jobs, enqueueEvent, released } = world();
    jobs.register(
      own,
      start(own, "a1", {
        sessionKey: "C1:100.1",
        threadTs: "100.1",
        conversationKind: "shared",
      }),
    );

    jobs.poll();
    expect(enqueueEvent).not.toHaveBeenCalled();
    expect(released).toEqual([]);

    finish(own, "a1", 3, "line one\nline two\n", now + 65_000);
    now += 66_000;
    jobs.poll();
    jobs.poll();

    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(enqueueEvent.mock.calls[0]![0]).toEqual({
      type: "mention",
      address: own.address,
      conversationKind: "shared",
      user: "U1",
      ts: "job:a1",
      thread_ts: "100.1",
      sessionKey: "C1:100.1",
      text: [
        "[job a1 exited 3 after 1m 5s] npm test",
        `Its output is in /workspace/${own.key}/.jobs/a1/log; read it with bash.`,
      ].join("\n"),
    });
    expect(records(own)).toEqual([
      expect.objectContaining({ delivered: true, ended: { at: 1_065_000, exitCode: 3 } }),
    ]);
    expect(released).toEqual([own.key]);
  });

  test("a notice the platform does not accept is offered again on the next poll", async () => {
    const own = office();
    const { jobs, enqueueEvent } = world();
    jobs.register(own, start(own, "a1"));
    finish(own, "a1", 0, "ok\n");
    enqueueEvent.mockReturnValueOnce(false);

    jobs.poll();
    expect(records(own)[0]).toMatchObject({ delivered: false });
    jobs.poll();
    jobs.poll();

    expect(enqueueEvent).toHaveBeenCalledTimes(2);
    expect(records(own)[0]).toMatchObject({ delivered: true });
  });

  test("at the limit it kills the job's process group, reports it once, and ignores a late exit file", async () => {
    const own = office();
    const { jobs, enqueueEvent, containers, released } = world({ limitMs: 60_000 });
    jobs.register(own, start(own, "a1"));
    jobDir(own, "a1");

    now += 59_000;
    jobs.poll();
    expect(containers.exec).not.toHaveBeenCalled();

    now += 1000;
    jobs.poll();
    expect(containers.exec).toHaveBeenCalledExactlyOnceWith(own.key, [
      "sh",
      "-c",
      'kill -- -"$(cat "$1")"',
      "kill",
      `/workspace/${own.key}/.jobs/a1/pid`,
    ]);
    finish(own, "a1", 143);
    jobs.poll();

    expect(enqueueEvent).toHaveBeenCalledTimes(1);
    expect(enqueueEvent.mock.calls[0]![0].text).toMatch(
      /^\[job a1 ended without an exit code after 1m 0s: it reached the 1m 0s limit and was killed, or its sandbox stopped\] npm test\nIts output is in \S+\/\.jobs\/a1\/log; read it with bash\.$/,
    );
    expect(released).toEqual([own.key]);
  });

  test("a job is still reported when its container cannot be reached at the limit", async () => {
    const own = office();
    const { jobs, enqueueEvent, containers } = world({ limitMs: 1000 });
    containers.exec.mockRejectedValueOnce(new Error("container is not running"));
    jobs.register(own, start(own, "a1"));
    now += 1000;

    jobs.poll();

    expect(enqueueEvent).toHaveBeenCalledTimes(1);
  });

  test("the production limit is two hours", async () => {
    const own = office();
    const { jobs, enqueueEvent } = world();
    jobs.register(own, start(own, "a1"));
    now += 2 * 60 * 60 * 1000 - 1;
    jobs.poll();
    expect(enqueueEvent).not.toHaveBeenCalled();
    now += 1;
    jobs.poll();
    expect(enqueueEvent.mock.calls[0]![0].text).toContain("the 2h 0m limit");
  });

  describe("after a restart", () => {
    test("retains the containers of running jobs and reports each ended job exactly once", async () => {
      const own = office();
      const other = office("D2");
      const before = world();
      before.jobs.register(own, start(own, "run1"));
      before.jobs.register(own, start(own, "done1"));
      before.jobs.register(other, start(other, "told1", { sessionKey: "D2" }));
      finish(other, "told1", 0);
      before.jobs.poll();
      expect(before.enqueueEvent).toHaveBeenCalledTimes(1);
      finish(own, "done1", 1, "failed while down\n");

      const after = world();
      after.jobs.restore();
      expect(after.containers.retain.mock.calls).toEqual([[own.key], [own.key]]);
      expect(after.enqueueEvent).not.toHaveBeenCalled();

      after.jobs.poll();
      after.jobs.poll();
      expect(after.enqueueEvent).toHaveBeenCalledTimes(1);
      expect(after.enqueueEvent.mock.calls[0]![0]).toMatchObject({
        ts: "job:done1",
        sessionKey: "D1",
      });
      expect(after.released).toEqual([own.key]);

      finish(own, "run1", 0);
      after.jobs.poll();
      expect(after.enqueueEvent).toHaveBeenCalledTimes(2);
    });

    test("unreadable records are skipped without stopping the others", async () => {
      const own = office();
      const broken = office("D2");
      const before = world();
      before.jobs.register(own, start(own, "a1"));
      mkdirSync(broken.stateDir, { recursive: true });
      writeFileSync(join(broken.stateDir, "jobs.json"), '{"jobs":[{"id":"../x"}]}');
      finish(own, "a1", 0);

      const after = world();
      after.jobs.restore();
      after.jobs.poll();

      expect(after.enqueueEvent).toHaveBeenCalledTimes(1);
    });
  });

  test("a started job that never ran is forgotten", async () => {
    const own = office();
    const { jobs, enqueueEvent, released } = world({ limitMs: 1000 });
    jobs.register(own, start(own, "a1"));
    jobs.forget(own, "a1");
    now += 5000;
    jobs.poll();

    expect(records(own)).toEqual([]);
    expect(released).toEqual([own.key]);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });

  test("delivered records are dropped after a week", async () => {
    const own = office();
    const { jobs } = world();
    jobs.register(own, start(own, "old1"));
    finish(own, "old1", 0);
    jobs.poll();
    now += 7 * 24 * 60 * 60 * 1000 + 1;
    jobs.register(own, start(own, "new1"));

    expect(records(own).map((job) => job.id)).toEqual(["new1"]);
  });

  describe("files the sandbox can replace", () => {
    test("an exit file that is a symbolic link is not read", async () => {
      const own = office();
      const outside = join(dir, "host-file");
      writeFileSync(outside, "0\n");
      const { jobs, enqueueEvent } = world();
      jobs.register(own, start(own, "a1"));
      symlinkSync(outside, join(jobDir(own, "a1"), "exit"));

      jobs.poll();

      expect(enqueueEvent).not.toHaveBeenCalled();
    });

    test("the log is never read: the notice only names it", async () => {
      const own = office();
      const { jobs, enqueueEvent } = world();
      jobs.register(own, start(own, "a1"));
      finish(own, "a1", 0, "PRINTED BY THE JOB\n");

      jobs.poll();

      expect(enqueueEvent.mock.calls[0]![0].text).not.toContain("PRINTED BY THE JOB");
    });

    test("a job directory or jobs directory that is a symbolic link is not entered", async () => {
      const own = office();
      const outside = join(dir, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "exit"), "0\n");
      writeFileSync(join(outside, "log"), "HOST SECRET\n");
      const { jobs, enqueueEvent } = world();
      jobs.register(own, start(own, "a1"));
      mkdirSync(join(own.dir, ".jobs"));
      symlinkSync(outside, join(own.dir, ".jobs", "a1"));
      jobs.poll();
      expect(enqueueEvent).not.toHaveBeenCalled();

      const second = office("D2");
      jobs.register(second, start(second, "b2", { sessionKey: "D2" }));
      mkdirSync(join(outside, "b2"));
      writeFileSync(join(outside, "b2", "exit"), "0\n");
      symlinkSync(outside, join(second.dir, ".jobs"));
      jobs.poll();
      expect(enqueueEvent).not.toHaveBeenCalled();
    });

    test("an exit file that is not a small number, or not a regular file, is not an exit", async () => {
      const own = office();
      const { jobs, enqueueEvent } = world();
      for (const [id, content] of [
        ["a1", "0; rm -rf /\n"],
        ["b2", "256\n"],
        ["c3", "-1\n"],
        ["d4", `${"9".repeat(4096)}\n`],
      ] as const) {
        jobs.register(own, start(own, id));
        writeFileSync(join(jobDir(own, id), "exit"), content);
      }
      jobs.register(own, start(own, "e5"));
      mkdirSync(join(jobDir(own, "e5"), "exit"));

      jobs.poll();

      expect(enqueueEvent).not.toHaveBeenCalled();
    });
  });
});
