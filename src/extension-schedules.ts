/**
 * Host-authoritative store + scheduler for extension callback schedules.
 *
 * `api.schedules` callback specs fire trusted host-side handlers, so unlike
 * the agent-writable workspace event bus (`events/`, watched by
 * EventsWatcher), these schedules persist under the host-only state dir:
 * `<stateDir>/conversations/<officeKey>/extension-schedules/<slug>.<name>.json`.
 * A sandboxed agent can neither create nor edit them — the file is written
 * exclusively by extension code running in the mikan process.
 *
 * One process-wide scheduler arms every schedule with croner (periodic cron
 * or a one-shot ISO date), survives restarts via a boot scan, and dispatches
 * fires to the conversation runtime, which materializes the conversation's
 * harness and runs the registered `onCallback` handler — no agent run, no
 * model call.
 */
import { Cron } from "croner";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { isValidIsoTimestampWithOffset } from "./harness/event-format.js";
import type {
  ExtensionCallbackScheduleSpec,
  ExtensionScheduleCallbackFire,
  ExtensionScheduleEngine,
  ExtensionScheduleInfo,
} from "./harness/index.js";
import * as log from "./log.js";
import { officeStateDir } from "./office/index.js";
import type { OfficeAddress } from "./types.js";
import {
  atomicWritePrivateFile,
  ensureDirExists,
  parseJsonSchemaValue,
} from "./utils/file-guards.js";

const SCHEDULES_DIRNAME = "extension-schedules";

/** On-disk record: the fire payload plus the schedule's timing fields. */
const CallbackScheduleFileSchema = Type.Object({
  platform: Type.String(),
  conversationId: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  type: Type.Union([Type.Literal("periodic"), Type.Literal("one-shot")]),
  schedule: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String()),
  at: Type.Optional(Type.String()),
  callback: Type.String(),
  args: Type.Optional(Type.Unknown()),
});

type CallbackScheduleRecord = Static<typeof CallbackScheduleFileSchema>;

function specFromRecord(record: CallbackScheduleRecord): ExtensionCallbackScheduleSpec {
  const action = {
    callback: record.callback,
    ...(record.args !== undefined ? { args: record.args } : {}),
  };
  return record.type === "periodic"
    ? {
        type: "periodic",
        schedule: record.schedule ?? "",
        timezone: record.timezone ?? "",
        ...action,
      }
    : { type: "one-shot", at: record.at ?? "", ...action };
}

export class ExtensionCallbackScheduler implements ExtensionScheduleEngine {
  /** Armed croner instances keyed by schedule file path. */
  private crons = new Map<string, Cron>();

  constructor(
    private options: {
      stateDir: string;
      /** Resolves false when no handler is registered for the fire. */
      dispatch: (fire: ExtensionScheduleCallbackFire) => Promise<boolean>;
    },
  ) {}

  /** Arm every persisted schedule. Call once after the runtime is ready. */
  start(): void {
    const conversationsDir = join(this.options.stateDir, "conversations");
    if (!existsSync(conversationsDir)) return;
    let armed = 0;
    for (const officeDir of readdirSync(conversationsDir)) {
      const schedulesDir = join(conversationsDir, officeDir, SCHEDULES_DIRNAME);
      if (!existsSync(schedulesDir)) continue;
      for (const filename of readdirSync(schedulesDir)) {
        if (!filename.endsWith(".json")) continue;
        if (this.armFromDisk(join(schedulesDir, filename))) armed++;
      }
    }
    if (armed > 0) log.logInfo(`Extension callback schedules armed: ${armed}`);
  }

  /** Disarm everything (shutdown). Persisted files re-arm on next start. */
  stop(): void {
    for (const cron of this.crons.values()) cron.stop();
    this.crons.clear();
  }

  async upsert(
    address: OfficeAddress,
    slug: string,
    name: string,
    spec: ExtensionCallbackScheduleSpec,
  ): Promise<void> {
    if (spec.type === "one-shot") {
      if (!isValidIsoTimestampWithOffset(spec.at)) {
        throw new Error("`at` must be a valid ISO 8601 timestamp with UTC offset");
      }
      if (new Date(spec.at).getTime() <= Date.now()) {
        throw new Error("`at` must be in the future");
      }
    }
    const record: CallbackScheduleRecord = {
      platform: address.platform,
      conversationId: address.conversationId,
      slug,
      name,
      type: spec.type,
      ...(spec.type === "periodic" ? { schedule: spec.schedule, timezone: spec.timezone } : {}),
      ...(spec.type === "one-shot" ? { at: spec.at } : {}),
      callback: spec.callback,
      // Round-tripped through JSON so what fires later is exactly what
      // persisting kept (functions and other non-JSON values never survive).
      ...(spec.args !== undefined
        ? { args: JSON.parse(JSON.stringify(spec.args)) as unknown }
        : {}),
    };
    const filePath = this.filePath(address, slug, name);
    // Validate by arming first: an invalid cron pattern or timezone throws
    // here, before anything is persisted or replaced.
    this.arm(filePath, record);
    ensureDirExists(join(officeStateDir(this.options.stateDir, address), SCHEDULES_DIRNAME));
    atomicWritePrivateFile(filePath, JSON.stringify(record, null, 2));
  }

  async delete(address: OfficeAddress, slug: string, name: string): Promise<boolean> {
    const filePath = this.filePath(address, slug, name);
    this.disarm(filePath);
    if (!existsSync(filePath)) return false;
    rmSync(filePath, { force: true });
    return true;
  }

  async list(address: OfficeAddress, slug: string): Promise<ExtensionScheduleInfo[]> {
    const schedulesDir = join(officeStateDir(this.options.stateDir, address), SCHEDULES_DIRNAME);
    if (!existsSync(schedulesDir)) return [];
    const prefix = `${slug}.`;
    const infos: ExtensionScheduleInfo[] = [];
    for (const filename of readdirSync(schedulesDir).toSorted()) {
      if (!filename.startsWith(prefix) || !filename.endsWith(".json")) continue;
      const record = await this.readRecord(join(schedulesDir, filename));
      if (record && record.slug === slug) {
        infos.push({ name: record.name, spec: specFromRecord(record) });
      }
    }
    return infos;
  }

  private filePath(address: OfficeAddress, slug: string, name: string): string {
    return join(
      officeStateDir(this.options.stateDir, address),
      SCHEDULES_DIRNAME,
      `${slug}.${name}.json`,
    );
  }

  private async readRecord(filePath: string): Promise<CallbackScheduleRecord | undefined> {
    try {
      const content = await readFile(filePath, "utf-8");
      return parseJsonSchemaValue(
        content,
        CallbackScheduleFileSchema,
        (detail) => `Malformed extension schedule ${filePath}: ${detail}`,
      );
    } catch (err) {
      log.logWarning(
        `Skipping unreadable extension schedule: ${filePath}`,
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  private armFromDisk(filePath: string): boolean {
    try {
      const record = parseJsonSchemaValue(
        readFileSync(filePath, "utf-8"),
        CallbackScheduleFileSchema,
        (detail) => `Malformed extension schedule ${filePath}: ${detail}`,
      );
      this.arm(filePath, record);
      return this.crons.has(filePath);
    } catch (err) {
      // Never delete on parse failure: a code bug must not destroy schedules.
      log.logWarning(
        `Skipping invalid extension schedule: ${filePath}`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  /**
   * Replace the armed cron for one schedule file. Throws on an invalid cron
   * pattern or timezone BEFORE touching the existing arm, so a failed upsert
   * leaves the previous schedule running.
   */
  private arm(filePath: string, record: CallbackScheduleRecord): void {
    const fire = () => void this.fire(filePath, record);
    let cron: Cron | undefined;
    if (record.type === "periodic") {
      if (!record.schedule || !record.timezone) {
        throw new Error("`schedule` and `timezone` are required for periodic schedules");
      }
      cron = new Cron(record.schedule, { timezone: record.timezone }, fire);
    } else {
      if (!record.at) throw new Error("`at` is required for one-shot schedules");
      const at = new Date(record.at);
      if (at.getTime() <= Date.now()) {
        // Fired while we were down (or was written in the past): drop it,
        // mirroring the event watcher's stale one-shot handling. Only the
        // boot scan reaches here — upsert rejects past timestamps.
        log.logInfo(`Extension schedule in the past, deleting: ${filePath}`);
        rmSync(filePath, { force: true });
      } else {
        cron = new Cron(at, fire);
      }
    }
    this.disarm(filePath);
    if (cron) this.crons.set(filePath, cron);
  }

  private disarm(filePath: string): void {
    const cron = this.crons.get(filePath);
    if (cron) {
      cron.stop();
      this.crons.delete(filePath);
    }
  }

  private async fire(filePath: string, record: CallbackScheduleRecord): Promise<void> {
    if (record.type === "one-shot") {
      this.disarm(filePath);
      rmSync(filePath, { force: true });
    }
    try {
      const consumed = await this.options.dispatch({
        platform: record.platform,
        conversationId: record.conversationId,
        slug: record.slug,
        scheduleName: record.name,
        callback: record.callback,
        ...(record.args !== undefined ? { args: record.args } : {}),
      });
      if (!consumed) {
        log.logWarning(
          `Extension schedule callback has no registered handler: ${record.slug}.${record.name} → ${record.callback}`,
          filePath,
        );
      }
    } catch (err) {
      log.logWarning(
        `Extension schedule dispatch failed: ${record.slug}.${record.name}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
