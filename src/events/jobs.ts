import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import {
  atomicWritePrivateFile,
  pinDirectoryNoFollow,
  readSmallTextFileNoFollowIfExists,
  readJsonSchemaFileIfExists,
  type PinnedDirectory,
} from "../file-guards.js";
import * as log from "../log.js";
import { createConversationEvent, listRegisteredOffices } from "../office/index.js";
import type { Office, Workspace } from "../office/types.js";
import type { ConversationKind, MessagingBot } from "../types.js";
import { errorMessage } from "../unknown-values.js";

export interface BackgroundJobStart {
  id: string;
  command: string;
  label: string;
  sessionKey: string;
  threadTs: string | undefined;
  userId: string;
  conversationKind: ConversationKind;
  guestDir: string;
}

export interface BackgroundJobSink {
  register(office: Office, job: BackgroundJobStart): void;
  forget(office: Office, id: string): void;
}

export interface JobContainers {
  retain(containerKey: string): () => void;
  exec(containerKey: string, command: string[]): Promise<unknown>;
}

interface BackgroundJobsOptions {
  containers?: JobContainers;
  limitMs?: number;
  now?: () => number;
}

export const JOBS_DIR_NAME = ".jobs";
export const JOB_LIMIT_MS = 2 * 60 * 60 * 1000;
const JOB_NOTICE_COMMAND_CHARS = 200;
const POLL_INTERVAL_MS = 1000;
const DELIVERED_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EXIT_FILE_BYTES = 16;
const KILL_GROUP_SCRIPT = 'kill -- -"$(cat "$1")"';

const JOB_RUN_ID_PREFIX = "job:";

export function jobRunId(id: string): string {
  return `${JOB_RUN_ID_PREFIX}${id}`;
}

export function isJobRunId(id: string): boolean {
  return id.startsWith(JOB_RUN_ID_PREFIX);
}

const JobRecordSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9]+$" }),
  command: Type.String(),
  label: Type.String(),
  sessionKey: Type.String(),
  threadTs: Type.Optional(Type.String()),
  userId: Type.String(),
  conversationKind: Type.Union([Type.Literal("direct"), Type.Literal("shared")]),
  guestDir: Type.String(),
  startedAt: Type.Number(),
  ended: Type.Optional(Type.Object({ at: Type.Number(), exitCode: Type.Optional(Type.Number()) })),
  delivered: Type.Boolean(),
});

const JobFileSchema = Type.Object({ jobs: Type.Array(JobRecordSchema) });

type JobRecord = Static<typeof JobRecordSchema>;

interface OfficeJobs {
  office: Office;
  jobs: JobRecord[];
}

function jobRecordsPath(office: Office): string {
  return join(office.stateDir, "jobs.json");
}

export function formatJobDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function readExit(office: Office, id: string): { exitCode: number; at: number } | undefined {
  let jobs: PinnedDirectory | undefined;
  let job: PinnedDirectory | undefined;
  try {
    jobs = pinDirectoryNoFollow(join(office.dir, JOBS_DIR_NAME));
    job = pinDirectoryNoFollow(jobs.pathOf(id));
    const file = readSmallTextFileNoFollowIfExists(job.pathOf("exit"), EXIT_FILE_BYTES);
    const text = file?.text.trim() ?? "";
    if (!file || !/^\d{1,3}$/.test(text) || Number(text) > 255) return undefined;
    return { exitCode: Number(text), at: file.mtimeMs };
  } catch {
    return undefined;
  } finally {
    job?.close();
    jobs?.close();
  }
}

export class BackgroundJobs implements BackgroundJobSink {
  private readonly offices = new Map<string, OfficeJobs>();
  private readonly retains = new Map<string, () => void>();
  private readonly containers: JobContainers | undefined;
  private readonly limitMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly workspace: Workspace,
    private readonly botsByPlatform: Record<string, MessagingBot>,
    options: BackgroundJobsOptions = {},
  ) {
    this.containers = options.containers;
    this.limitMs = options.limitMs ?? JOB_LIMIT_MS;
    this.now = options.now ?? Date.now;
  }

  restore(): void {
    for (const record of listRegisteredOffices(this.workspace.stateDir)) {
      const office = this.workspace.office(record);
      let jobs: JobRecord[];
      try {
        jobs =
          readJsonSchemaFileIfExists(
            jobRecordsPath(office),
            JobFileSchema,
            (detail) => `Malformed job records: ${detail}`,
          )?.jobs ?? [];
      } catch (error) {
        log.logWarning(`Ignoring the job records of ${office.key}`, errorMessage(error));
        continue;
      }
      if (jobs.length === 0) continue;
      this.offices.set(office.key, { office, jobs });
      for (const job of jobs) {
        if (!job.ended) this.retain(office, job.id);
      }
    }
  }

  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  register(office: Office, start: BackgroundJobStart): void {
    const entry = this.offices.get(office.key) ?? { office, jobs: [] };
    if (entry.jobs.some((job) => job.id === start.id)) return;
    entry.jobs = [...entry.jobs, { ...start, startedAt: this.now(), delivered: false }];
    this.offices.set(office.key, entry);
    this.save(entry);
    this.retain(office, start.id);
  }

  forget(office: Office, id: string): void {
    const entry = this.offices.get(office.key);
    if (!entry) return;
    entry.jobs = entry.jobs.filter((job) => job.id !== id);
    this.save(entry);
    this.release(office, id);
  }

  poll(): void {
    for (const entry of this.offices.values()) {
      for (const job of entry.jobs) this.advance(entry, job);
    }
  }

  private advance(entry: OfficeJobs, job: JobRecord): void {
    if (job.delivered) return;
    try {
      if (!job.ended) this.check(entry, job);
      if (job.ended) this.deliver(entry, job);
    } catch (error) {
      log.logWarning(`Job ${job.id} of ${entry.office.key} was not checked`, errorMessage(error));
    }
  }

  private check(entry: OfficeJobs, job: JobRecord): void {
    const { office } = entry;
    const exit = readExit(office, job.id);
    if (!exit && this.now() - job.startedAt < this.limitMs) return;
    job.ended = exit
      ? { at: Math.min(Math.max(exit.at, job.startedAt), this.now()), exitCode: exit.exitCode }
      : { at: this.now(), exitCode: undefined };
    this.save(entry);
    if (!exit) this.kill(office, job);
    this.release(office, job.id);
  }

  private kill(office: Office, job: JobRecord): void {
    this.containers
      ?.exec(office.key, ["sh", "-c", KILL_GROUP_SCRIPT, "kill", `${job.guestDir}/pid`])
      .catch((error: unknown) =>
        log.logInfo(
          `Job ${job.id} of ${office.key} was not killed at its limit: ${errorMessage(error)}`,
        ),
      );
  }

  private deliver(entry: OfficeJobs, job: JobRecord): void {
    const { office } = entry;
    const bot = this.botsByPlatform[office.address.platform];
    if (!bot) return;
    const accepted = bot.enqueueEvent(
      createConversationEvent({
        platform: office.address.platform,
        type: job.conversationKind === "direct" ? "dm" : "mention",
        conversationId: office.address.conversationId,
        conversationKind: job.conversationKind,
        user: job.userId,
        text: this.notice(job),
        ts: jobRunId(job.id),
        thread_ts: job.threadTs,
        sessionKey: job.sessionKey,
      }),
    );
    if (!accepted) return;
    job.delivered = true;
    this.save(entry);
  }

  private notice(job: JobRecord): string {
    const duration = formatJobDuration((job.ended?.at ?? this.now()) - job.startedAt);
    const exitCode = job.ended?.exitCode;
    const outcome =
      exitCode === undefined
        ? `ended without an exit code after ${duration}: it reached the ${formatJobDuration(this.limitMs)} limit and was killed, or its sandbox stopped`
        : `exited ${exitCode} after ${duration}`;
    const command = job.command.replace(/\s+/g, " ").slice(0, JOB_NOTICE_COMMAND_CHARS);
    return `[job ${job.id} ${outcome}] ${command}\nIts output is in ${job.guestDir}/log; read it with bash.`;
  }

  private save(entry: OfficeJobs): void {
    const cutoff = this.now() - DELIVERED_RECORD_TTL_MS;
    entry.jobs = entry.jobs.filter((job) => !job.delivered || (job.ended?.at ?? 0) > cutoff);
    mkdirSync(entry.office.stateDir, { recursive: true, mode: 0o700 });
    atomicWritePrivateFile(
      jobRecordsPath(entry.office),
      `${JSON.stringify({ jobs: entry.jobs } satisfies Static<typeof JobFileSchema>)}\n`,
    );
  }

  private retain(office: Office, id: string): void {
    const key = `${office.key}/${id}`;
    if (this.retains.has(key) || !this.containers) return;
    this.retains.set(key, this.containers.retain(office.key));
  }

  private release(office: Office, id: string): void {
    const key = `${office.key}/${id}`;
    this.retains.get(key)?.();
    this.retains.delete(key);
  }
}
