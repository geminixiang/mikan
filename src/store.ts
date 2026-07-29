import { appendFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import {
  ensureDirExists,
  isRecord,
  parseJsonValue,
  readTextFileIfExists,
} from "./utils/file-guards.js";
import { withRetry } from "./adapters/shared.js";

export type { Attachment, ChannelStoreConfig, LoggedMessage } from "./types.js";
import type { Attachment, ChannelStoreConfig, LoggedMessage } from "./types.js";
import { createOfficeAddress, type Office, type Workspace } from "./office/index.js";

class AttachmentDownloadHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function isRetryableAttachmentDownloadError(error: unknown): boolean {
  if (!(error instanceof AttachmentDownloadHttpError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

/**
 * Slack office store: message logs and attachment downloads for one Slack
 * workspace (the bot token is a Slack credential). Channel ids are therefore
 * Slack conversation ids; other platforms log through their adapters.
 */
export class ChannelStore {
  private workspace: Workspace;
  private botToken: string;
  // Track recently logged message timestamps to prevent duplicates
  // Key: "channelId:ts", automatically cleaned up after 60 seconds
  private recentlyLogged = new Map<string, number>();
  private loggingMessages = new Set<string>();

  constructor(config: ChannelStoreConfig) {
    this.workspace = config.workspace;
    this.botToken = config.botToken;

    // Ensure working directory exists
    ensureDirExists(this.workspace.root);
  }

  private office(channelId: string): Office {
    return this.workspace.office(createOfficeAddress("slack", channelId));
  }

  /**
   * Get or create the directory for a channel/DM
   */
  getChannelDir(channelId: string): string {
    return this.office(channelId).ensure();
  }

  /**
   * Generate a unique local filename for an attachment
   */
  generateLocalFilename(originalName: string, timestamp: string): string {
    // Convert slack timestamp (1234567890.123456) to milliseconds
    const ts = Math.floor(parseFloat(timestamp) * 1000);
    // Sanitize original name (remove problematic characters)
    const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${ts}_${sanitized}`;
  }

  /**
   * Process attachments from a Slack message event.
   * Downloads files before returning so callers only receive readable paths.
   */
  async processAttachments(
    channelId: string,
    files: Array<{ name?: string; url_private_download?: string; url_private?: string }>,
    timestamp: string,
  ): Promise<Attachment[]> {
    // Attachment downloads can be the office's first write; materialize (and
    // register) it before composing office-relative attachment paths.
    this.getChannelDir(channelId);
    const downloads: Array<Promise<Attachment>> = [];

    for (const file of files) {
      const url = file.url_private_download || file.url_private;
      if (!url) continue;
      if (!file.name) {
        throw new Error(`Attachment missing name for URL: ${url}`);
      }

      const filename = this.generateLocalFilename(file.name, timestamp);
      const localPath = `${this.office(channelId).key}/attachments/${filename}`;
      const attachment: Attachment = {
        original: file.name,
        localPath,
      };

      downloads.push(
        this.downloadAttachmentWithRetry(localPath, url)
          .then(() => attachment)
          .catch((error) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to download attachment ${localPath}: ${errorMsg}`, {
              cause: error,
            });
          }),
      );
    }

    return Promise.all(downloads);
  }

  /**
   * Log a message to the channel's log.jsonl
   * Returns false if message was already logged (duplicate)
   */
  async logMessage(channelId: string, message: LoggedMessage): Promise<boolean> {
    // Check for duplicate (same channel + timestamp)
    const dedupeKey = `${channelId}:${message.ts}`;
    if (this.recentlyLogged.has(dedupeKey) || this.loggingMessages.has(dedupeKey)) {
      return false; // Already logged or being logged
    }
    this.loggingMessages.add(dedupeKey);

    const logPath = join(this.getChannelDir(channelId), "log.jsonl");

    // Ensure message has a date field
    if (!message.date) {
      // Parse timestamp to get date
      let date: Date;
      if (message.ts.includes(".")) {
        // Slack timestamp format (1234567890.123456)
        date = new Date(parseFloat(message.ts) * 1000);
      } else {
        // Epoch milliseconds
        date = new Date(parseInt(message.ts, 10));
      }
      message.date = date.toISOString();
    }

    try {
      const line = `${JSON.stringify(message)}\n`;
      await appendFile(logPath, line, "utf-8");

      // Mark as logged only after the append succeeds. Otherwise a transient
      // write failure can make retries look like duplicates and drop messages.
      this.recentlyLogged.set(dedupeKey, Date.now());
      setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60000);
      return true;
    } finally {
      this.loggingMessages.delete(dedupeKey);
    }
  }

  /**
   * Log a bot response
   */
  async logBotResponse(channelId: string, text: string, ts: string): Promise<void> {
    await this.logMessage(channelId, {
      date: new Date().toISOString(),
      ts,
      user: "bot",
      text,
      attachments: [],
      isMessagingBot: true,
    });
  }

  /**
   * Get the timestamp of the last logged message for a channel
   * Returns null if no log exists
   */
  getLastTimestamp(channelId: string): string | null {
    const logPath = this.office(channelId).logPath;
    const content = readTextFileIfExists(logPath);
    if (content === undefined) {
      return null;
    }

    try {
      const lines = content.trim().split("\n");
      if (lines.length === 0 || lines[0] === "") {
        return null;
      }
      const lastLine = lines[lines.length - 1];
      const message = parseJsonValue(
        lastLine,
        (value): value is LoggedMessage => isRecord(value) && typeof value.ts === "string",
        (detail) => (detail === "unexpected JSON shape" ? "log entry missing timestamp" : detail),
      );
      return message.ts;
    } catch {
      return null;
    }
  }

  /**
   * Download a single attachment
   */
  private async downloadAttachmentWithRetry(localPath: string, url: string): Promise<void> {
    await withRetry(() => this.downloadAttachment(localPath, url), {
      maxAttempts: 3,
      baseDelayMs: 250,
      isRateLimited: isRetryableAttachmentDownloadError,
    });
  }

  private async downloadAttachment(localPath: string, url: string): Promise<void> {
    const filePath = join(this.workspace.root, localPath);

    // Ensure directory exists
    const parentDir = join(this.workspace.root, dirname(localPath));
    ensureDirExists(parentDir);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.botToken}`,
      },
    });

    if (!response.ok) {
      throw new AttachmentDownloadHttpError(
        `HTTP ${response.status}: ${response.statusText}`,
        response.status,
      );
    }

    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));
  }
}
