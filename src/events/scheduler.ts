import { Cron } from "croner";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createConversationEvent } from "../adapter.js";
import type { ConversationKind, MessagingBot, PlatformName } from "../adapter.js";
import * as log from "../log.js";
import { listRegisteredOffices, officeKey, type Workspace } from "../office/index.js";
import { reportUserFacingError } from "../observability/index.js";
import { inferConversationKind } from "../sessions/session-key.js";
import type { OfficeAddress } from "../types.js";
import {
  officeEventsDir,
  parseEventPayload,
  type EventRecord,
  type EventScheduleSink,
  type MikanEvent,
  type PeriodicEventInfo,
} from "./index.js";

export type { MikanEvent, PeriodicEventInfo } from "./index.js";

interface Scheduled {
  address: OfficeAddress;
  filename: string;
  event: MikanEvent;
  timer?: NodeJS.Timeout;
  cron?: Cron;
}

/**
 * In-memory timer/cron owner for every office's admitted events. Records are
 * loaded once from each registered office's host-only events directory at
 * start; afterwards the only inputs are {@link OfficeEventStore} mutations
 * through {@link EventScheduleSink}. There is no filesystem watcher: files
 * edited by hand take effect on the next start.
 */
export class EventScheduler implements EventScheduleSink {
  private readonly scheduled = new Map<string, Scheduled>();
  private startTime = Date.now();

  constructor(
    private readonly workspace: Workspace,
    private readonly botsByPlatform: Record<string, MessagingBot>,
  ) {}

  start(): void {
    this.startTime = Date.now();
    let loaded = 0;
    for (const record of listRegisteredOffices(this.workspace.stateDir)) {
      const office = this.workspace.office(record);
      const dir = officeEventsDir(office);
      if (!existsSync(dir)) continue;
      for (const filename of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
        const path = join(dir, filename);
        try {
          const payload = parseEventPayload(readFileSync(path, "utf-8"), filename);
          this.scheduleRecord(office.address, { filename, payload, size: 0, mtimeMs: 0 });
          loaded++;
        } catch (error) {
          log.logWarning(
            `Removing unparseable event file ${filename} for ${office.key}`,
            error instanceof Error ? error.message : String(error),
          );
          this.removeFile(office.address, filename);
        }
      }
    }
    log.logInfo(`Event scheduler started, tracking ${loaded} records`);
  }

  stop(): void {
    for (const entry of this.scheduled.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.cron?.stop();
    }
    this.scheduled.clear();
    log.logInfo("Event scheduler stopped");
  }

  scheduledCount(): number {
    return this.scheduled.size;
  }

  /** Active periodic events of one office with their next run. */
  periodicEvents(address: OfficeAddress): PeriodicEventInfo[] {
    const prefix = `${officeKey(address)}/`;
    const results: PeriodicEventInfo[] = [];
    for (const [key, entry] of this.scheduled) {
      if (!key.startsWith(prefix) || entry.event.type !== "periodic" || !entry.cron) continue;
      results.push({
        filename: entry.filename,
        platform: entry.event.platform,
        conversationId: entry.event.conversationId,
        conversationKind: entry.event.conversationKind,
        text: entry.event.text,
        schedule: entry.event.schedule,
        timezone: entry.event.timezone,
        nextRun: entry.cron.nextRun()?.toISOString() ?? null,
      });
    }
    return results;
  }

  scheduleRecord(address: OfficeAddress, record: EventRecord): void {
    const key = this.key(address, record.filename);
    this.cancelKey(key);
    let event: MikanEvent;
    try {
      event = this.resolve(record, address);
    } catch (error) {
      log.logWarning(
        `Rejecting event ${record.filename}`,
        error instanceof Error ? error.message : String(error),
      );
      this.removeFile(address, record.filename);
      return;
    }
    const entry: Scheduled = { address, filename: record.filename, event };
    switch (event.type) {
      case "immediate":
        this.execute(entry);
        return;
      case "one-shot": {
        const delay = new Date(event.at).getTime() - Date.now();
        if (delay <= 0) {
          log.logInfo(`One-shot event in the past, deleting: ${record.filename}`);
          this.removeFile(address, record.filename);
          return;
        }
        entry.timer = setTimeout(() => {
          this.scheduled.delete(key);
          this.execute(entry);
        }, delay);
        this.scheduled.set(key, entry);
        return;
      }
      case "periodic":
        try {
          entry.cron = new Cron(event.schedule, { timezone: event.timezone }, () =>
            this.execute(entry, false),
          );
        } catch (error) {
          log.logWarning(`Invalid cron schedule for ${record.filename}`, String(error));
          this.removeFile(address, record.filename);
          return;
        }
        this.scheduled.set(key, entry);
    }
  }

  cancelRecord(address: OfficeAddress, filename: string): void {
    this.cancelKey(this.key(address, filename));
  }

  private key(address: OfficeAddress, filename: string): string {
    return `${officeKey(address)}/${filename}`;
  }

  private cancelKey(key: string): void {
    const entry = this.scheduled.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.cron?.stop();
    this.scheduled.delete(key);
  }

  private resolve(record: EventRecord, address: OfficeAddress): MikanEvent {
    const { payload } = record;
    const platform = (payload.platform ?? address.platform).toLowerCase();
    if (platform !== address.platform || payload.conversationId !== address.conversationId) {
      throw new Error("event payload does not address its owning office");
    }
    if (!this.botsByPlatform[platform]) {
      throw new Error(`no bot configured for platform '${platform}'`);
    }
    const conversationKind: ConversationKind =
      payload.conversationKind ?? inferConversationKind(platform, payload.conversationId);
    return { ...payload, platform, conversationKind };
  }

  private execute(entry: Scheduled, deleteAfter = true): void {
    const { event, filename, address } = entry;
    const bot = this.botsByPlatform[event.platform];
    if (!bot) {
      this.reportFailure(entry, deleteAfter, "missing_bot");
      if (deleteAfter) this.removeFile(address, filename);
      return;
    }
    const enqueued = bot.enqueueEvent(
      createConversationEvent({
        platform: event.platform as PlatformName,
        type: "mention",
        conversationId: event.conversationId,
        conversationKind: event.conversationKind,
        user: event.userId ?? "EVENT",
        text: buildEventPrompt(event),
        ts: `event:${filename.replace(/\.json$/i, "")}`,
      }),
    );
    if (!enqueued) {
      log.logWarning(`Event queue full, discarded: ${filename}`);
      this.reportFailure(entry, deleteAfter, "queue_full");
    }
    if (deleteAfter) this.removeFile(address, filename);
  }

  private reportFailure(
    entry: Scheduled,
    deleteAfter: boolean,
    failure: "missing_bot" | "queue_full",
  ): void {
    const reason = failure === "missing_bot" ? "missing bot" : "queue full";
    reportUserFacingError(new Error(`Scheduled event delivery failed: ${reason}`), {
      domain: "events",
      surface: "event_delivery",
      operation: "event_execute",
      severity: "error",
      platform: entry.event.platform,
      context: {
        failure,
        filename: entry.filename,
        eventType: entry.event.type,
        conversationId: entry.event.conversationId,
        conversationKind: entry.event.conversationKind,
        deleteAfter,
        triggeredByEventFile: true,
        textLength: entry.event.text.length,
      },
    });
  }

  private removeFile(address: OfficeAddress, filename: string): void {
    const path = join(officeEventsDir(this.workspace.office(address)), filename);
    try {
      unlinkSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "ENOENT") {
        log.logWarning(`Failed to delete event file: ${filename}`, String(error));
      }
    }
  }
}

export function buildEventPrompt(event: MikanEvent): string {
  switch (event.type) {
    case "one-shot":
      return [
        "Please deliver the following reminder to the user in a short, natural way.",
        "Do not greet, do not introduce yourself, and do not ask generic follow-up questions.",
        "",
        `Reminder: ${event.text}`,
      ].join("\n");
    case "periodic":
      return [
        "Handle the following recurring task.",
        "Respond concisely. If there is nothing actionable to report, reply with [SILENT].",
        "",
        `Task: ${event.text}`,
      ].join("\n");
    case "immediate":
      return [
        "Handle the following event/update in a concise, context-appropriate way.",
        "If it reads like a reminder or follow-up, deliver it directly without greeting or generic offers to help.",
        "",
        `Event: ${event.text}`,
      ].join("\n");
  }
}
