import chalk from "chalk";
import { formatToolArgs } from "./adapters/shared.js";

export type { LogContext } from "./types.js";
import type { LogContext } from "./types.js";

function timestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `[${hh}:${mm}:${ss}]`;
}

function formatContext(ctx: LogContext): string {
  const session = ctx.sessionId ? `:${ctx.sessionId}` : "";
  if (ctx.conversationId.startsWith("D")) {
    return `[DM:${ctx.userName || ctx.conversationId}${session}]`;
  }
  const conversation = ctx.conversationName || ctx.conversationId;
  const user = ctx.userName || "unknown";
  return `[${conversation.startsWith("#") ? conversation : `#${conversation}`}:${user}${session}]`;
}

// Keep stdout/stderr lines manageable when echoing tool/agent output. Long bodies
// flow through Sentry and session storage; the console stream just needs a preview.
const LOG_PREVIEW_MAX = 1000;

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.substring(0, maxLen)}\n(truncated at ${maxLen} chars)`;
}

// User messages
export function logUserMessage(ctx: LogContext, text: string): void {
  console.log(chalk.green(`${timestamp()} ${formatContext(ctx)} ${text}`));
}

// Tool execution
export function logToolStart(
  ctx: LogContext,
  toolName: string,
  label: string,
  args: Record<string, unknown>,
): void {
  const formattedArgs = formatToolArgs(args);
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ↳ ${toolName}: ${label}`));
  if (formattedArgs) {
    // Indent the args
    const indented = formattedArgs
      .split("\n")
      .map((line) => `           ${line}`)
      .join("\n");
    console.log(chalk.dim(indented));
  }
}

export function logToolSuccess(
  ctx: LogContext,
  toolName: string,
  durationMs: number,
  result: string,
): void {
  const duration = (durationMs / 1000).toFixed(1);
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✓ ${toolName} (${duration}s)`));

  const truncated = truncate(result, LOG_PREVIEW_MAX);
  if (truncated) {
    const indented = truncated
      .split("\n")
      .map((line) => `           ${line}`)
      .join("\n");
    console.log(chalk.dim(indented));
  }
}

export function logToolError(
  ctx: LogContext,
  toolName: string,
  durationMs: number,
  error: string,
): void {
  const duration = (durationMs / 1000).toFixed(1);
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✗ ${toolName} (${duration}s)`));

  const truncated = truncate(error, LOG_PREVIEW_MAX);
  const indented = truncated
    .split("\n")
    .map((line) => `           ${line}`)
    .join("\n");
  console.log(chalk.dim(indented));
}

// Agent run
export function logAgentRunStart(
  ctx: LogContext,
  provider: string,
  model: string,
  modelName?: string,
): void {
  const displayName = modelName && modelName !== model ? ` (${modelName})` : "";
  console.log(
    chalk.blue(
      `${timestamp()} ${formatContext(ctx)} ▶ Agent run: ${provider}/${model}${displayName}`,
    ),
  );
}

// Response streaming
export function logResponseStart(ctx: LogContext): void {
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} → Streaming response...`));
}

export function logThinking(ctx: LogContext, thinking: string): void {
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💭 Thinking`));
  const truncated = truncate(thinking, LOG_PREVIEW_MAX);
  const indented = truncated
    .split("\n")
    .map((line) => `           ${line}`)
    .join("\n");
  console.log(chalk.dim(indented));
}

export function logResponse(ctx: LogContext, text: string): void {
  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💬 Response`));
  const truncated = truncate(text, LOG_PREVIEW_MAX);
  const indented = truncated
    .split("\n")
    .map((line) => `           ${line}`)
    .join("\n");
  console.log(chalk.dim(indented));
}

// System
export function logInfo(message: string): void {
  console.log(chalk.blue(`${timestamp()} [system] ${message}`));
}

export function logWarning(message: string, details?: string): void {
  console.log(chalk.yellow(`${timestamp()} [system] ⚠ ${message}`));
  if (details) {
    const indented = details
      .split("\n")
      .map((line) => `           ${line}`)
      .join("\n");
    console.log(chalk.dim(indented));
  }
}

export function logAgentError(ctx: LogContext | "system", error: string): void {
  const context = ctx === "system" ? "[system]" : formatContext(ctx);
  console.log(chalk.yellow(`${timestamp()} ${context} ✗ Agent error`));
  const indented = error
    .split("\n")
    .map((line) => `           ${line}`)
    .join("\n");
  console.log(chalk.dim(indented));
}

function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

// Usage summary
export function logUsageSummary(
  ctx: LogContext,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  },
  contextTokens?: number,
  contextWindow?: number,
): string {
  const lines: string[] = [];
  lines.push("_Usage Summary_");
  lines.push(
    `Input:     ${usage.input.toLocaleString()} tokens · ${usage.cacheRead.toLocaleString()} cached`,
  );
  lines.push(`Output:    ${usage.output.toLocaleString()} tokens`);
  if (contextTokens && contextWindow) {
    const contextPercent = ((contextTokens / contextWindow) * 100).toFixed(1);
    lines.push(
      `Context:   ${formatTokenCount(contextTokens)} / ${formatTokenCount(contextWindow)} (${contextPercent}%)`,
    );
  }
  const costParts: string[] = [
    `\$${usage.cost.input.toFixed(4)} in`,
    `\$${usage.cost.cacheRead.toFixed(4)} cache`,
    `\$${usage.cost.output.toFixed(4)} out`,
  ];
  lines.push(`Cost:      ` + costParts.join(" + ") + ` = *\$${usage.cost.total.toFixed(4)}*`);

  const summary = lines.join("\n");

  console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💰 Usage`));
  console.log(
    chalk.dim(
      `           in ${usage.input.toLocaleString()} → out ${usage.output.toLocaleString()} = $${usage.cost.total.toFixed(4)}`,
    ),
  );

  return summary;
}

// Startup (no context needed)
export function logStartup(workingDir: string, sandbox: string): void {
  console.log("Starting mikan...");
  console.log(`  Working directory: ${workingDir}`);
  console.log(`  Sandbox: ${sandbox}`);
}

export function logConnected(platform: string): void {
  console.log(`⚡️ Mikan connected to ${platform} and listening!`);
  console.log("");
}

export function logDisconnected(): void {
  console.log("Mikan disconnected.");
}

// Backfill
export function logBackfillStart(channelCount: number): void {
  console.log(chalk.blue(`${timestamp()} [system] Backfilling ${channelCount} channels...`));
}

export function logBackfillChannel(channelName: string, messageCount: number): void {
  console.log(chalk.blue(`${timestamp()} [system]   #${channelName}: ${messageCount} messages`));
}

export function logBackfillComplete(totalMessages: number, durationMs: number): void {
  const duration = (durationMs / 1000).toFixed(1);
  console.log(
    chalk.blue(
      `${timestamp()} [system] Backfill complete: ${totalMessages} messages in ${duration}s`,
    ),
  );
}
