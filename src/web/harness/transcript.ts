import type { HarnessTranscriptItem } from "@geminixiang/mikan-harness-web-contract";
import type { SessionEntry, SessionStore } from "../../harness/index.js";
import { extractHistoryLineText } from "../../sessions/history-line.js";

export function projectTranscript(store: SessionStore): HarnessTranscriptItem[] {
  return store.getBranch().flatMap((entry) => {
    const transcriptItem = projectEntry(entry);
    return transcriptItem ? [transcriptItem] : [];
  });
}

export function sessionTitle(store: SessionStore): string {
  const named = store.getSessionName()?.trim();
  if (named) return named;
  for (const transcriptItem of projectTranscript(store)) {
    if (transcriptItem.role !== "user" || !transcriptItem.text) continue;
    return titleFromPrompt(transcriptItem.text);
  }
  return "New conversation";
}

export function sessionUpdatedAt(store: SessionStore): string {
  return (
    store.getBranch().at(-1)?.timestamp ?? store.getHeader()?.timestamp ?? new Date(0).toISOString()
  );
}

export function titleFromPrompt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 56 ? `${normalized.slice(0, 53)}…` : normalized || "New conversation";
}

function projectEntry(entry: SessionEntry): HarnessTranscriptItem | undefined {
  if (entry.type === "message") return projectMessage(entry);
  if (entry.type === "compaction") {
    return createTranscriptItem(entry.id, "system", "Context compacted", entry.summary, {
      timestamp: entry.timestamp,
      tone: "muted",
    });
  }
  if (entry.type === "branch_summary") {
    return createTranscriptItem(entry.id, "system", "Session summary", entry.summary, {
      timestamp: entry.timestamp,
      tone: "muted",
    });
  }
  if (entry.type === "model_change") {
    return createTranscriptItem(
      entry.id,
      "system",
      "Model changed",
      `${entry.provider}/${entry.modelId}`,
      { timestamp: entry.timestamp, tone: "muted" },
    );
  }
  if (entry.type === "thinking_level_change") {
    return createTranscriptItem(entry.id, "system", "Thinking level changed", entry.thinkingLevel, {
      timestamp: entry.timestamp,
      tone: "muted",
    });
  }
  if (entry.type === "custom_message" && entry.display) {
    return createTranscriptItem(
      entry.id,
      "system",
      entry.customType,
      contentToText(entry.content),
      { timestamp: entry.timestamp, tone: "muted" },
    );
  }
  return undefined;
}

function projectMessage(entry: Extract<SessionEntry, { type: "message" }>): HarnessTranscriptItem {
  const message = entry.message as unknown as Record<string, unknown>;
  const role = typeof message.role === "string" ? message.role : "unknown";
  const text = contentToText(message.content);
  switch (role) {
    case "user":
      return createTranscriptItem(entry.id, "user", "You", extractHistoryLineText(text), {
        timestamp: entry.timestamp,
      });
    case "assistant":
      return createTranscriptItem(
        entry.id,
        "assistant",
        "mikan",
        text || stringValue(message.errorMessage),
        { timestamp: entry.timestamp },
      );
    case "toolResult":
      return createTranscriptItem(
        entry.id,
        "tool",
        `Tool · ${stringValue(message.toolName) || "unknown"}`,
        text,
        {
          timestamp: entry.timestamp,
          tone: message.isError === true ? "error" : "ok",
        },
      );
    case "bashExecution": {
      const command = stringValue(message.command).trim();
      const output = stringValue(message.output).trim();
      return createTranscriptItem(
        entry.id,
        "tool",
        "Bash",
        [command ? `$ ${command}` : "", output].filter(Boolean).join("\n\n"),
        {
          timestamp: entry.timestamp,
          tone: typeof message.exitCode === "number" && message.exitCode !== 0 ? "error" : "ok",
        },
      );
    }
    default:
      return createTranscriptItem(entry.id, "system", `Message · ${role}`, text, {
        timestamp: entry.timestamp,
        tone: "muted",
      });
  }
}

function createTranscriptItem(
  id: string,
  role: HarnessTranscriptItem["role"],
  title: string,
  text: string,
  metadata: Pick<HarnessTranscriptItem, "timestamp"> & {
    tone?: HarnessTranscriptItem["tone"];
  },
): HarnessTranscriptItem {
  return {
    id,
    role,
    title,
    text,
    timestamp: metadata.timestamp,
    ...(metadata.tone ? { tone: metadata.tone } : {}),
  };
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
    if (value.type === "thinking" && typeof value.thinking === "string") {
      parts.push(`[thinking]\n${value.thinking}`);
    }
    if (value.type === "toolCall") {
      const name = stringValue(value.name) || "tool";
      const args = value.arguments === undefined ? "" : JSON.stringify(value.arguments, null, 2);
      parts.push([`[tool] ${name}`, args].filter(Boolean).join("\n"));
    }
  }
  return parts.join("\n\n");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
