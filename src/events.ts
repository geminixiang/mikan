import { Type, type Static } from "@sinclair/typebox";
import { Cron } from "croner";
import {
  existsSync,
  type FSWatcher,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  watch,
} from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import type { MessagingBot, ConversationEvent, ConversationKind } from "./adapter.js";
import { ensureDirExists, parseJsonSchemaValue } from "./utils/file-guards.js";
import * as log from "./log.js";
import { reportUserFacingError } from "./observability/sentry.js";
import { inferConversationKind } from "./sessions/policy.js";

export type {
  ImmediateEvent,
  MikanEvent,
  OneShotEvent,
  PeriodicEvent,
  PeriodicEventInfo,
} from "./types.js";
import type { ImmediateEvent, MikanEvent, OneShotEvent, PeriodicEvent } from "./types.js";

const EventFileSchema = Type.Object({
  type: Type.Optional(
    Type.Union([Type.Literal("immediate"), Type.Literal("one-shot"), Type.Literal("periodic")]),
  ),
  platform: Type.Optional(Type.String()),
  conversationId: Type.Optional(Type.String()),
  channelId: Type.Optional(Type.String()),
  conversationKind: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("shared")])),
  userId: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  at: Type.Optional(Type.String()),
  schedule: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String()),
});

type EventFileData = Static<typeof EventFileSchema>;

import type { PeriodicEventInfo } from "./types.js";

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;

export class EventsWatcher {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private crons: Map<string, Cron> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private startTime: number;
  private watcher: FSWatcher | null = null;
  private knownFiles: Set<string> = new Set();

  constructor(
    private eventsDir: string,
    private botsByPlatform: Record<string, MessagingBot>,
  ) {
    this.startTime = Date.now();
  }

  /**
   * Start watching for events. Call this after platform bots are initialized.
   */
  start(): void {
    // Ensure events directory exists
    ensureDirExists(this.eventsDir);

    log.logInfo(`Events watcher starting, dir: ${this.eventsDir}`);

    // Scan existing files
    this.scanExisting();

    // Watch for changes
    this.watcher = watch(this.eventsDir, (eventType, filename) => {
      if (!filename || !filename.endsWith(".json")) return;
      log.logInfo(
        `Events watcher fs event: ${String(eventType)} ${filename} (exists=${existsSync(join(this.eventsDir, filename))})`,
      );
      this.debounce(filename, () => this.handleFileChange(filename));
    });

    log.logInfo(`Events watcher started, tracking ${this.knownFiles.size} files`);
  }

  /**
   * Stop watching and cancel all scheduled events.
   */
  stop(): void {
    // Stop fs watcher
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Cancel all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Cancel all scheduled timers
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    // Cancel all cron jobs
    for (const cron of this.crons.values()) {
      cron.stop();
    }
    this.crons.clear();

    this.knownFiles.clear();
    log.logInfo("Events watcher stopped");
  }

  /**
   * Return all active periodic (cron) events with their next run time.
   */
  getPeriodicEvents(): PeriodicEventInfo[] {
    const results: PeriodicEventInfo[] = [];
    for (const [filename, cron] of this.crons) {
      const filePath = join(this.eventsDir, filename);
      try {
        const content = readFileSync(filePath, "utf-8");
        const data = this.parseEvent(content, filename);
        if (!data || data.type !== "periodic") {
          continue;
        }
        const next = cron.nextRun();
        results.push({
          filename,
          platform: data.platform,
          conversationId: data.conversationId,
          conversationKind: data.conversationKind,
          text: data.text,
          schedule: data.schedule,
          timezone: data.timezone,
          nextRun: next?.toISOString() ?? null,
        });
      } catch {
        // File may have been deleted or corrupted, skip
      }
    }
    return results;
  }

  private debounce(filename: string, fn: () => void): void {
    const existing = this.debounceTimers.get(filename);
    if (existing) {
      clearTimeout(existing);
    }
    this.debounceTimers.set(
      filename,
      setTimeout(() => {
        this.debounceTimers.delete(filename);
        fn();
      }, DEBOUNCE_MS),
    );
  }

  private scanExisting(): void {
    let files: string[];
    try {
      files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
    } catch (err) {
      log.logWarning("Failed to read events directory", String(err));
      return;
    }

    for (const filename of files) {
      this.handleFile(filename);
    }
  }

  private handleFileChange(filename: string): void {
    const filePath = join(this.eventsDir, filename);
    const exists = existsSync(filePath);
    const known = this.knownFiles.has(filename);
    log.logInfo(`Handling event file change: ${filename} (exists=${exists}, known=${known})`);

    if (!exists) {
      // fs.watch can briefly report a file as missing during create/rename churn.
      // Confirm deletion before canceling scheduled events.
      void this.handleDelete(filename);
    } else if (known) {
      // File was modified - cancel existing and re-schedule
      this.cancelScheduled(filename, "file-modified");
      void this.handleFile(filename);
    } else {
      // New file
      void this.handleFile(filename);
    }
  }

  private async handleDelete(filename: string): Promise<void> {
    if (!this.knownFiles.has(filename)) return;

    const filePath = join(this.eventsDir, filename);
    for (let i = 0; i < MAX_RETRIES; i++) {
      const delay = RETRY_BASE_MS * 2 ** i;
      await new Promise((resolve) => setTimeout(resolve, delay));
      const exists = existsSync(filePath);
      log.logInfo(`Confirming event deletion: ${filename} after ${delay}ms (exists=${exists})`);
      if (exists) {
        return;
      }
    }

    if (this.timers.has(filename)) {
      log.logInfo(
        `Ignoring deleted one-shot file after scheduling: ${filename} (timer remains active)`,
      );
      return;
    }

    log.logInfo(`Event file deleted: ${filename}`);
    this.cancelScheduled(filename, "confirmed-delete");
    this.knownFiles.delete(filename);
  }

  private cancelScheduled(filename: string, reason = "unspecified"): void {
    const timer = this.timers.get(filename);
    const cron = this.crons.get(filename);
    log.logInfo(
      `Canceling scheduled event: ${filename} (reason=${reason}, timer=${Boolean(timer)}, cron=${Boolean(cron)})`,
    );
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(filename);
    }

    if (cron) {
      cron.stop();
      this.crons.delete(filename);
    }
  }

  private async handleFile(filename: string): Promise<void> {
    const filePath = join(this.eventsDir, filename);
    log.logInfo(`Loading event file: ${filename} from ${filePath}`);

    // Parse with retries
    let event: MikanEvent | null = null;
    let lastError: Error | null = null;

    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const content = await readFile(filePath, "utf-8");
        event = this.parseEvent(content, filename);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * 2 ** i));
        }
      }
    }

    if (!event) {
      log.logWarning(
        `Failed to parse event file after ${MAX_RETRIES} retries: ${filename}`,
        lastError?.message,
      );
      this.deleteFile(filename, "parse-failed");
      return;
    }

    this.knownFiles.add(filename);
    log.logInfo(
      `Parsed event file: ${filename} (${event.type} for ${event.platform}/${event.conversationId})`,
    );

    // Schedule based on type
    switch (event.type) {
      case "immediate":
        this.handleImmediate(filename, event);
        break;
      case "one-shot":
        this.handleOneShot(filename, event);
        break;
      case "periodic":
        this.handlePeriodic(filename, event);
        break;
    }
  }

  private parseEvent(content: string, filename: string): MikanEvent | null {
    const data: EventFileData = parseJsonSchemaValue(content, EventFileSchema, (detail) =>
      detail === "unexpected JSON shape"
        ? `Expected top-level JSON object in ${filename}`
        : `Malformed event file ${filename}: ${detail}`,
    );
    const conversationId =
      typeof data.conversationId === "string"
        ? data.conversationId
        : typeof data.channelId === "string"
          ? data.channelId
          : undefined;
    const type = typeof data.type === "string" ? data.type : undefined;
    const text = typeof data.text === "string" ? data.text : undefined;

    if (!type || !conversationId || !text) {
      throw new Error(`Missing required fields (type, conversationId, text) in ${filename}`);
    }

    const platform = this.resolvePlatform(data.platform, filename);
    const conversationKind = this.resolveConversationKind(
      platform,
      conversationId,
      data.conversationKind,
    );
    const userId = typeof data.userId === "string" ? data.userId : undefined;
    switch (type) {
      case "immediate":
        return {
          type: "immediate",
          platform,
          conversationId,
          conversationKind,
          userId,
          text,
        };

      case "one-shot":
        if (typeof data.at !== "string" || data.at.length === 0) {
          throw new Error(`Missing 'at' field for one-shot event in ${filename}`);
        }
        return {
          type: "one-shot",
          platform,
          conversationId,
          conversationKind,
          userId,
          text,
          at: data.at,
        };

      case "periodic":
        if (typeof data.schedule !== "string" || data.schedule.length === 0) {
          throw new Error(`Missing 'schedule' field for periodic event in ${filename}`);
        }
        if (typeof data.timezone !== "string" || data.timezone.length === 0) {
          throw new Error(`Missing 'timezone' field for periodic event in ${filename}`);
        }
        return {
          type: "periodic",
          platform,
          conversationId,
          conversationKind,
          userId,
          text,
          schedule: data.schedule,
          timezone: data.timezone,
        };

      default:
        throw new Error(`Unknown event type '${type}' in ${filename}`);
    }
  }

  private resolvePlatform(platformValue: unknown, filename: string): string {
    const availablePlatforms = Object.keys(this.botsByPlatform);

    if (typeof platformValue === "string" && platformValue.trim().length > 0) {
      const platform = platformValue.trim().toLowerCase();
      if (!this.botsByPlatform[platform]) {
        throw new Error(
          `Unknown platform '${platformValue}' in ${filename}. Expected one of: ${availablePlatforms.join(", ")}`,
        );
      }
      return platform;
    }

    if (availablePlatforms.length === 1) {
      return availablePlatforms[0];
    }

    throw new Error(
      `Missing required field 'platform' in ${filename}. Available platforms: ${availablePlatforms.join(", ")}`,
    );
  }

  private resolveConversationKind(
    platform: string,
    conversationId: string,
    conversationKindValue: unknown,
  ): ConversationKind {
    if (conversationKindValue === "direct" || conversationKindValue === "shared") {
      return conversationKindValue;
    }

    return inferConversationKind(platform, conversationId);
  }

  private handleImmediate(filename: string, event: ImmediateEvent): void {
    const filePath = join(this.eventsDir, filename);

    // Check if stale (created before harness started)
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < this.startTime) {
        log.logInfo(`Stale immediate event, deleting: ${filename}`);
        this.deleteFile(filename, "stale-immediate");
        return;
      }
    } catch {
      // File may have been deleted
      return;
    }

    log.logInfo(`Executing immediate event: ${filename}`);
    this.execute(filename, event);
  }

  private handleOneShot(filename: string, event: OneShotEvent): void {
    const atTime = new Date(event.at).getTime();
    const now = Date.now();

    if (atTime <= now) {
      // Past - delete without executing
      log.logInfo(`One-shot event in the past, deleting: ${filename}`);
      this.deleteFile(filename, "one-shot-in-past");
      return;
    }

    const delay = atTime - now;
    log.logInfo(
      `Scheduling one-shot event: ${filename} in ${Math.round(delay / 1000)}s (at=${event.at}, now=${new Date(now).toISOString()})`,
    );

    const timer = setTimeout(() => {
      this.timers.delete(filename);
      log.logInfo(`Executing one-shot event: ${filename}`);
      this.execute(filename, event);
    }, delay);

    this.timers.set(filename, timer);
    log.logInfo(`Stored one-shot timer: ${filename} (active timers=${this.timers.size})`);
  }

  private handlePeriodic(filename: string, event: PeriodicEvent): void {
    try {
      const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
        log.logInfo(`Executing periodic event: ${filename}`);
        this.execute(filename, event, false); // Don't delete periodic events
      });

      this.crons.set(filename, cron);

      const next = cron.nextRun();
      log.logInfo(
        `Scheduled periodic event: ${filename}, next run: ${next?.toISOString() ?? "unknown"}`,
      );
    } catch (err) {
      log.logWarning(`Invalid cron schedule for ${filename}: ${event.schedule}`, String(err));
      this.deleteFile(filename, "invalid-cron");
    }
  }

  private execute(filename: string, event: MikanEvent, deleteAfter: boolean = true): void {
    const message = this.buildEventPrompt(event);
    const bot = this.botsByPlatform[event.platform];

    if (!bot) {
      log.logWarning(`No bot configured for event platform '${event.platform}'`, filename);
      this.reportEventDeliveryFailure(filename, event, deleteAfter, "missing_bot");
      if (deleteAfter) {
        this.deleteFile(filename, "missing-bot");
      }
      return;
    }

    const eventId = filename.replace(/\.json$/i, "");
    const botEvent: ConversationEvent = {
      type: "mention",
      conversationId: event.conversationId,
      conversationKind: event.conversationKind,
      user: event.userId ?? "EVENT",
      text: message,
      ts: `event:${eventId}`,
    };

    // Enqueue for processing
    const enqueued = bot.enqueueEvent(botEvent);

    if (enqueued && deleteAfter) {
      // Delete file after successful enqueue (immediate and one-shot)
      this.deleteFile(filename, "executed-and-enqueued");
    } else if (!enqueued) {
      log.logWarning(`Event queue full, discarded: ${filename}`);
      this.reportEventDeliveryFailure(filename, event, deleteAfter, "queue_full");
      // Still delete immediate/one-shot even if discarded
      if (deleteAfter) {
        this.deleteFile(filename, "queue-full-discarded");
      }
    }
  }

  private reportEventDeliveryFailure(
    filename: string,
    event: MikanEvent,
    deleteAfter: boolean,
    failure: "missing_bot" | "queue_full",
  ): void {
    const reason = failure === "missing_bot" ? "missing bot" : "queue full";
    reportUserFacingError(new Error(`Scheduled event delivery failed: ${reason}`), {
      domain: "events",
      surface: "event_delivery",
      operation: "event_execute",
      severity: "error",
      platform: event.platform,
      context: {
        failure,
        filename,
        eventType: event.type,
        conversationId: event.conversationId,
        conversationKind: event.conversationKind,
        deleteAfter,
        triggeredByEventFile: true,
        textLength: event.text.length,
      },
    });
  }

  private buildEventPrompt(event: MikanEvent): string {
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

  private deleteFile(filename: string, reason = "unspecified"): void {
    const filePath = join(this.eventsDir, filename);
    log.logInfo(`Deleting event file: ${filename} (reason=${reason})`);
    try {
      unlinkSync(filePath);
    } catch (err) {
      // ENOENT is fine (file already deleted), other errors are warnings
      if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
        log.logWarning(`Failed to delete event file: ${filename}`, String(err));
      }
    }
    this.knownFiles.delete(filename);
  }
}
