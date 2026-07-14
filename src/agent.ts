/**
 * Agent runner: prompt construction, path translation, run lifecycle, and createRunner.
 * Single module — do not split helpers that only this file uses.
 */

export type { PiAgentWrapper } from "./types.js";
import type { PiAgentWrapper } from "./types.js";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type ImageContent, type Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_EVENT_BUDGET,
  defaultExtensionDirs,
  type ExtensionHostServices,
  type ExtensionRegistry,
  type ExtensionSchedulePayload,
  formatSkillsForPrompt,
  loadExtensions,
  loadSkillsFromDir,
  MikanAgentSession,
  MikanModels,
  type MikanSkill,
  parseCommandInput,
  type RunOrigin,
  type SessionStore,
} from "./harness/index.js";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile } from "fs/promises";
import { join, posix } from "path";
import type {
  ConversationKind,
  ConversationMessage,
  ConversationResponder,
  MessagingInfo,
  PlatformName,
} from "./adapter.js";
import type {
  AgentEventPayload,
  MikanEvent,
  PlatformNotifier,
  PlatformReactor,
  PlatformTrustModel,
  PlatformUploader,
  SandboxResourceController,
} from "./types.js";
import type { SessionViewTokenStoreLike } from "./commands/types.js";
import { resolveConversationSettings } from "./config.js";
import { readEnv } from "./utils/env.js";
import { ActorExecutionResolver } from "./execution-resolver.js";
import * as log from "./log.js";
import type { DockerContainerManager } from "./provisioner.js";
import {
  createExecutor,
  type Executor,
  type RuntimePathContext,
  type SandboxConfig,
} from "./sandbox/index.js";
import { createMountedRuntimePathContext } from "./sandbox/path-context.js";
import {
  addLifecycleBreadcrumb,
  metricAttributes,
  reportUserFacingError,
  updateActiveSpanAttribution,
} from "./observability/sentry.js";
import type { VaultManager } from "./vault/index.js";
import { AgentMemoryFileManager } from "./sessions/agent-memory-file-manager.js";
import { formatHistoryLine } from "./sessions/history-line.js";
import { conversationIdOf, isThreadSessionKey } from "./sessions/session-key.js";
import {
  extractSessionUuid,
  openManagedSession,
  type ResolvedSessionScope,
  type ThreadRootMessage,
} from "./sessions/store.js";
import { HostEventStore } from "./tools/event.js";
import { createMikanTools } from "./tools/index.js";
import type { PlatformToolPackFactory } from "./tools/types.js";
import * as Sentry from "@sentry/node";

import { emitAgentEvent } from "./agent-events.js";

export function getUnresolvedSandboxPathContext(
  sandboxConfig: SandboxConfig,
  hostWorkspaceRoot: string,
): RuntimePathContext {
  if (sandboxConfig.type === "image") {
    return createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace");
  }

  return createExecutor(sandboxConfig).getPathContext(hostWorkspaceRoot);
}

export function translateRuntimePathToHost(
  runtimePath: string,
  pathContext: RuntimePathContext,
): string {
  return pathContext.runtimeToHostPath?.(runtimePath) ?? runtimePath;
}

export function translateAttachPathToHost(
  filePath: string,
  pathContext: RuntimePathContext,
): string {
  const runtimePath = posix.isAbsolute(filePath)
    ? filePath
    : posix.join(pathContext.runtimeWorkspaceRoot, filePath);
  return translateRuntimePathToHost(runtimePath, pathContext);
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
  return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function formatTimestampedUserMessage(message: ConversationMessage): string {
  return formatHistoryLine({
    date: new Date(),
    userName: message.userName,
    threadTs: message.threadTs,
    text: message.text,
  });
}

function collectMessageAttachments(
  message: ConversationMessage,
  workspacePath: string,
  pathContext?: RuntimePathContext,
): { imageAttachments: ImageContent[]; nonImagePaths: string[] } {
  const imageAttachments: ImageContent[] = [];
  const nonImagePaths: string[] = [];

  for (const attachment of message.attachments || []) {
    const runtimePath = `${workspacePath}/${attachment.localPath}`;
    const hostPath = pathContext?.runtimeToHostPath?.(runtimePath) ?? runtimePath;
    const mimeType = getImageMimeType(attachment.localPath);

    if (mimeType && existsSync(hostPath)) {
      try {
        imageAttachments.push({
          type: "image",
          mimeType,
          data: readFileSync(hostPath).toString("base64"),
        });
      } catch {
        nonImagePaths.push(runtimePath);
      }
    } else {
      nonImagePaths.push(runtimePath);
    }
  }

  return { imageAttachments, nonImagePaths };
}

export function buildPromptPayload(
  message: ConversationMessage,
  workspacePath: string,
  pathContext?: RuntimePathContext,
): {
  userMessage: string;
  imageAttachments: ImageContent[];
} {
  let userMessage = formatTimestampedUserMessage(message);
  const { imageAttachments, nonImagePaths } = collectMessageAttachments(
    message,
    workspacePath,
    pathContext,
  );

  if (nonImagePaths.length > 0) {
    userMessage += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;
  }

  return { userMessage, imageAttachments };
}

async function getMemory(conversationDir: string): Promise<string> {
  const parts: string[] = [];

  // Read workspace-level memory (shared across all conversations)
  const workspaceMemoryPath = join(conversationDir, "..", "MEMORY.md");
  if (existsSync(workspaceMemoryPath)) {
    try {
      const content = (await readFile(workspaceMemoryPath, "utf-8")).trim();
      if (content) {
        parts.push(`### Global Workspace Memory\n${content}`);
      }
    } catch (error) {
      log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
    }
  }

  // Read conversation-specific memory
  const conversationMemoryPath = join(conversationDir, "MEMORY.md");
  if (existsSync(conversationMemoryPath)) {
    try {
      const content = (await readFile(conversationMemoryPath, "utf-8")).trim();
      if (content) {
        parts.push(`### Conversation-Specific Memory\n${content}`);
      }
    } catch (error) {
      log.logWarning("Failed to read conversation memory", `${conversationMemoryPath}: ${error}`);
    }
  }

  if (parts.length === 0) {
    return "(no working memory yet)";
  }

  return parts.join("\n\n");
}

function loadMikanSkills(conversationDir: string, workspacePath: string): MikanSkill[] {
  const skillMap = new Map<string, MikanSkill>();

  // conversationDir is the host path (e.g., /Users/.../data/C0A34FL8PMH)
  // hostWorkspacePath is the parent directory on host
  // workspacePath is the container path (e.g., /workspace)
  const hostWorkspacePath = join(conversationDir, "..");

  // Helper to translate host paths to container paths
  const translatePath = (hostPath: string): string => {
    if (hostPath.startsWith(hostWorkspacePath)) {
      return workspacePath + hostPath.slice(hostWorkspacePath.length);
    }
    return hostPath;
  };

  // Load workspace-level skills (global)
  const workspaceSkillsDir = join(hostWorkspacePath, "skills");
  for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
    // Translate paths to container paths for system prompt
    skill.filePath = translatePath(skill.filePath);
    skill.baseDir = translatePath(skill.baseDir);
    skillMap.set(skill.name, skill);
  }

  // Load conversation-specific skills (override workspace skills on collision)
  const conversationSkillsDir = join(conversationDir, "skills");
  for (const skill of loadSkillsFromDir({ dir: conversationSkillsDir, source: "channel" }).skills) {
    skill.filePath = translatePath(skill.filePath);
    skill.baseDir = translatePath(skill.baseDir);
    skillMap.set(skill.name, skill);
  }

  return Array.from(skillMap.values());
}

function buildRuntimePaths(runtimeWorkspaceRoot: string, conversationId: string) {
  const workspaceRoot = runtimeWorkspaceRoot.replace(/\/+$/, "") || "/";
  const conversationPath = posix.join(workspaceRoot, conversationId);
  return {
    workspaceRoot,
    conversationPath,
    scratchPath: posix.join(conversationPath, "scratch"),
  };
}

function buildEnvDescription(sandboxType: SandboxConfig["type"], workspaceRoot: string): string {
  switch (sandboxType) {
    case "image":
      return `You are running inside a managed per-user container.
- Runtime workspace root: ${workspaceRoot}
- Bash commands start in: ${workspaceRoot}
- Install tools with the image's package manager
- Your changes persist for this user's container until it is recreated`;
    case "container":
      return `You are running inside a shared container.
- Runtime workspace root: ${workspaceRoot}
- Bash commands start in: ${workspaceRoot}
- Install tools with the container's package manager
- Your changes persist across sessions`;
    case "firecracker":
      return `You are running inside a Firecracker microVM.
- Runtime workspace root: ${workspaceRoot}
- Use cd or absolute paths; project files are under ${workspaceRoot}
- Install tools with: apt-get install <package> (Debian-based)
- Your changes persist across sessions`;
    case "cloudflare":
      return `You are running through a Cloudflare Sandbox bridge.
- Runtime workspace root: ${workspaceRoot}
- Bash commands start in: ${workspaceRoot}
- Your commands run in a remote container managed by Cloudflare
- Important: the remote filesystem is not automatically synced back to the host workspace`;
    default:
      return `You are running directly on the host machine.
- Runtime workspace root: ${workspaceRoot}
- Bash commands start in: ${process.cwd()}
- Be careful with system modifications`;
  }
}

export function resolveTriggerAttribution(
  message: Pick<ConversationMessage, "id" | "text" | "userName">,
): string | undefined {
  const eventTextMatch = message.text.match(/^\[EVENT:([^:]+):/);
  if (eventTextMatch) return `[event: ${eventTextMatch[1]}]`;
  const eventIdMatch = message.id.match(/^event:([^:]+)/);
  if (eventIdMatch) return `[event: ${eventIdMatch[1]}]`;
  if (message.userName) return `@${message.userName}`;
  return undefined;
}

function buildSystemPrompt(
  workspacePath: string,
  conversationId: string,
  conversationKind: ConversationKind,
  currentUserId: string | undefined,
  memory: string,
  sandboxConfig: SandboxConfig,
  platform: MessagingInfo,
  skills: MikanSkill[],
): string {
  const { workspaceRoot, conversationPath, scratchPath } = buildRuntimePaths(
    workspacePath,
    conversationId,
  );
  const sandboxType = sandboxConfig.type;
  const isContainerLike = sandboxType === "container" || sandboxType === "image";
  const isFirecracker = sandboxType === "firecracker";

  // Format channel mappings
  const channelMappings =
    platform.channels.length > 0
      ? platform.channels.map((c) => `${c.id}\t#${c.name}`).join("\n")
      : "(no channels loaded)";

  // Format user mappings
  const userMappings =
    platform.users.length > 0
      ? platform.users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n")
      : "(no users loaded)";

  const envDescription = buildEnvDescription(sandboxType, workspaceRoot);
  // Per-turn instructions (event-trigger mode, attribution) are delivered with
  // the user message via buildTurnInstructions(), not baked in here, so this
  // system prompt stays byte-stable across a conversation's turns and keeps the
  // provider prompt cache warm (a changing system prefix invalidates the cache
  // for the whole request, including the far larger conversation history).
  const slackBlockKitInstructions =
    platform.name === "slack"
      ? `
## Slack Rendering
- The Slack adapter renders responses with Block Kit automatically. Answer normally using Slack mrkdwn.
- Do not emit markdown pipe tables; Slack does not render them as tables. Prefer short sections or bullet lists.
`
      : "";

  return `You are mikan, a ${platform.name} bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older human-readable history beyond your context, search \`log.jsonl\` (contains user messages and your final responses, but not tool results).
- Structured session history with tool results lives in \`${conversationPath}/sessions/\`.
- The active top-level session is selected by \`${conversationPath}/sessions/current\`, which points to a timestamped \`.jsonl\` file in the same directory.
- Scoped/thread sessions use fixed files at \`${conversationPath}/sessions/<scope_id>.jsonl\` (for example \`${conversationPath}/sessions/1777386320.800769.jsonl\`).
- If a user asks about something that should exist in conversation history but is not found in the current context window, do not answer "I don't know" or "I don't have that". Instead, search the thread session, top-level session, and \`log.jsonl\` before responding.
- User messages include a \`[in-thread:TS]\` marker when sent from within a platform thread/reply (TS is the thread or parent message identifier). Without this marker, the message is a top-level conversation message.
${platform.formattingGuide}${slackBlockKitInstructions}

## Platform IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).

## Environment
${envDescription}
- Default place for clones, downloads, and experiments: ${scratchPath}
- Do not use host-only paths unless you are running in host mode and verified they exist.

## Workspace Layout
${workspaceRoot}/
├── MEMORY.md                    # Global memory (all conversations)
├── skills/                      # Global CLI tools you create
└── ${conversationId}/           # This conversation
    ├── MEMORY.md                # Conversation-specific memory
    ├── log.jsonl                # Human-readable message history (no tool results)
    ├── sessions/                # Structured session history used for context reconstruction
    │   ├── current              # Active top-level session pointer
    │   ├── <timestamp>_<id>.jsonl  # Top-level session files
    │   └── <scope_id>.jsonl        # Scoped thread/reply session files
    ├── attachments/             # User-shared files
    ├── scratch/                 # Working directory for clones/downloads/experiments: ${scratchPath}
    └── skills/                  # Conversation-specific tools

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspaceRoot}/skills/<name>/\` (global) or \`${conversationPath}/skills/<name>/\` (conversation-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Events
Use the \`event\` tool to schedule immediate, one-shot, or periodic follow-ups. It writes to the host-side mikan control plane and fills routing fields for the current conversation automatically.

Write event \`text\` as a self-contained future task with needed context, tone, and constraints because events do not inherit normal conversation history.

For one-shot reminders, include a timezone offset in \`at\`. For periodic events, use a cron schedule plus IANA timezone; assume ${Intl.DateTimeFormat().resolvedOptions().timeZone} when users omit timezone.

When events trigger, messages are prefixed like \`[EVENT:filename:type:time]\`. Immediate and one-shot events auto-delete after triggering; periodic events persist until deleted.

For periodic events where there's nothing to report, respond with exactly \`[SILENT]\`. Debounce external triggers; prefer one summarized event over many.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspaceRoot}/MEMORY.md): skills, preferences, project info
- Conversation (${conversationPath}/MEMORY.md): conversation-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspaceRoot}/SYSTEM.md to log all environment modifications:
- Installed packages (apt install, npm install, uv pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isMessagingBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
Use \`log.jsonl\` for quick grep-style history. Use \`${conversationPath}/sessions/\` when you need structured turns, tool outputs, or thread/session lineage.
${isContainerLike || isFirecracker ? "Install jq: apt-get install jq" : ""}
\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'

# Inspect top-level session pointer and available session files
cat sessions/current
ls -1 sessions/
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- event: Schedule immediate, one-shot, or periodic follow-ups
- sandbox: Inspect or temporarily adjust sandbox limits
- attach: Share files to the platform

Each tool requires a "label" parameter (shown to user).
`;
}

/**
 * Instructions that vary per turn (event-trigger mode, response attribution).
 * These are delivered with the user message rather than baked into the system
 * prompt, so the system prompt stays cache-stable across a conversation's turns
 * (in a multi-user channel the attribution line alone changes every turn).
 * Returns an empty string when the turn needs no special framing.
 */
export function buildTurnInstructions(
  isEventTrigger: boolean,
  triggerAttribution: string | undefined,
  platformName: string,
): string {
  const parts: string[] = [];
  if (isEventTrigger) {
    parts.push(`## Event Trigger Mode
- You are handling a scheduled/background event, not opening a brand new chat with a stranger.
- Treat the incoming user message as a self-contained task prepared by an earlier run.
- Complete the task directly. Avoid generic greetings, self-introductions, or boilerplate offers to help.
- For reminders/follow-ups, prefer a short direct response that sounds like a continuation of prior intent.
- If the event text includes tone, brevity, or language instructions, follow them literally.`);
  }
  if (triggerAttribution) {
    parts.push(`## Attribution
Always end your final ${platformName} response and any GitHub issue/PR comments or descriptions you write via tools with:
_Triggered by ${triggerAttribution}_

Do not add this to \`[SILENT]\` responses.`);
  }
  return parts.join("\n\n");
}

export function appendTriggerAttribution(
  text: string,
  triggerAttribution: string | undefined,
  sessionLink?: string,
): string {
  if (!triggerAttribution) return text;
  const trimmed = text.trimEnd();
  const legacySuffix = `_Triggered by ${triggerAttribution}_`;
  // Slack mrkdwn italics cannot span a URL — a `_..._` wrapping a link renders
  // the underscores literally. Keep the session link outside the italic span.
  const suffix = sessionLink ? `${legacySuffix} · session: ${sessionLink}` : legacySuffix;
  if (trimmed.endsWith(suffix)) return text;
  const body = trimmed.endsWith(legacySuffix)
    ? trimmed.slice(0, -legacySuffix.length).trimEnd()
    : trimmed;
  return `${body}\n\n${suffix}`;
}

function mergeExtensionSkills(local: MikanSkill[], extension: MikanSkill[]): MikanSkill[] {
  if (extension.length === 0) return local;
  const byName = new Map<string, MikanSkill>();
  for (const skill of extension) byName.set(skill.name, skill);
  for (const skill of local) byName.set(skill.name, skill);
  return [...byName.values()];
}

interface RunnerSessionState {
  responder: ConversationResponder | null;
  logCtx: {
    conversationId: string;
    userName?: string;
    conversationName?: string;
    sessionId?: string;
  } | null;
  queue: {
    enqueue(fn: () => Promise<void>, errorContext: string): void;
  } | null;
  pendingTools: Map<string, { toolName: string; args: unknown; startTime: number }>;
  toolProgress: Map<string, { label: string; status: "running" | "done" | "error" }>;
  totalUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  llmCallCount: number;
  stopReason: string;
  errorMessage: string | undefined;
  reportedLlmError: boolean;
  finalResponseHandledByTool: boolean;
  triggerAttribution?: string;
}

function createEmptyUsageTotals() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createRunState(): RunnerSessionState {
  return {
    responder: null,
    logCtx: null,
    queue: null,
    pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
    toolProgress: new Map<string, { label: string; status: "running" | "done" | "error" }>(),
    totalUsage: createEmptyUsageTotals(),
    llmCallCount: 0,
    stopReason: "stop",
    errorMessage: undefined,
    reportedLlmError: false,
    finalResponseHandledByTool: false,
    triggerAttribution: undefined,
  };
}

function resetRunState(
  runState: RunnerSessionState,
  responder: ConversationResponder,
  sessionConversation: string,
  userName: string | undefined,
  sessionUuid: string,
  triggerAttribution: string | undefined,
): void {
  runState.responder = responder;
  runState.logCtx = {
    conversationId: sessionConversation,
    userName,
    conversationName: undefined,
    sessionId: sessionUuid,
  };
  runState.pendingTools.clear();
  runState.toolProgress.clear();
  runState.totalUsage = createEmptyUsageTotals();
  runState.llmCallCount = 0;
  runState.stopReason = "stop";
  runState.errorMessage = undefined;
  runState.reportedLlmError = false;
  runState.finalResponseHandledByTool = false;
  runState.triggerAttribution = triggerAttribution;
}

function createRunQueue(
  responder: ConversationResponder,
  runState: RunnerSessionState,
): {
  queue: { enqueue(fn: () => Promise<void>, errorContext: string): void };
  wait: () => Promise<void>;
} {
  let queueChain = Promise.resolve();
  return {
    queue: {
      enqueue(fn: () => Promise<void>, errorContext: string): void {
        queueChain = queueChain.then(async () => {
          if (runState.finalResponseHandledByTool) return;
          try {
            await fn();
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.logWarning(`API error (${errorContext})`, errMsg);
            try {
              await responder.respondDiagnostic(`Error: ${errMsg}`, { style: "error" });
            } catch {
              // Ignore
            }
          }
        });
      },
    },
    wait: () => queueChain,
  };
}

function getFinalAssistantText(session: MikanAgentSession): string {
  const lastAssistant = session.messages.findLast((message) => message.role === "assistant");
  return (
    lastAssistant?.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n") || ""
  );
}

function isEventTriggerAttribution(triggerAttribution: string | undefined): boolean {
  return triggerAttribution?.startsWith("[event:") === true;
}

function extractToolLabel(toolName: string, args: unknown): string {
  const label = (args as { label?: unknown } | undefined)?.label;
  if (typeof label !== "string") return toolName;
  return label.trim() || toolName;
}

function formatToolProgress(runState: RunnerSessionState): string {
  const lines = Array.from(runState.toolProgress.values()).map((item) => {
    const marker = item.status === "running" ? "•" : item.status === "error" ? "✗" : "✓";
    return `${marker} ${item.label}`;
  });
  return lines.join("\n");
}

function formatResponseWithToolProgress(text: string, runState: RunnerSessionState): string {
  const progress = formatToolProgress(runState);
  return progress ? `${progress}\n\n${text}` : text;
}

async function replaceResponseWithToolProgress(
  responder: ConversationResponder,
  runState: RunnerSessionState,
): Promise<void> {
  const progress = formatToolProgress(runState);
  if (progress) await responder.replaceResponse(progress);
}

async function finalizeRunResponse(
  responder: ConversationResponder,
  session: MikanAgentSession,
  runState: RunnerSessionState,
  options?: {
    triggerAttribution?: string;
    triggerSessionLink?: string;
    createOverflowLink?: () => string;
    platform?: string;
    model?: Model<Api>;
    sessionConversation?: string;
    sessionUuid?: string;
  },
): Promise<void> {
  if (runState.stopReason === "error" && runState.errorMessage) {
    if (!runState.reportedLlmError) {
      runState.reportedLlmError = true;
      reportUserFacingError(new Error("LLM run completed with error stop reason"), {
        domain: "llm",
        surface: "assistant_response",
        operation: "llm_turn",
        severity: "error",
        platform: options?.platform,
        provider: options?.model?.provider,
        model: options?.model?.name,
        stopReason: runState.stopReason,
        context: {
          sessionConversation: options?.sessionConversation,
          sessionUuid: options?.sessionUuid,
          hasErrorMessage: true,
          llmCallCount: runState.llmCallCount,
        },
      });
    }
    try {
      await responder.replaceResponse("_Sorry, something went wrong_");
      await responder.respondDiagnostic(`Error: ${runState.errorMessage}`, {
        style: "error",
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.logWarning("Failed to post error message", errMsg);
      reportUserFacingError(err, {
        domain: "chat_platform",
        surface: "final_response",
        operation: "finalize_error_response",
        severity: "error",
        platform: options?.platform,
        context: {
          sessionConversation: options?.sessionConversation,
          sessionUuid: options?.sessionUuid,
          stopReason: runState.stopReason,
        },
      });
    }
    return;
  }

  const finalText = getFinalAssistantText(session);
  if (runState.finalResponseHandledByTool) {
    log.logInfo("Final response already handled by tool - skipping final replacement");
    return;
  }
  if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
    try {
      await responder.deleteResponse();
      log.logInfo("Silent response - deleted message and thread");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.logWarning("Failed to delete message for silent response", errMsg);
    }
    return;
  }

  if (!finalText.trim()) return;

  try {
    await responder.replaceResponse(
      appendTriggerAttribution(
        formatResponseWithToolProgress(finalText, runState),
        options?.triggerAttribution,
        options?.triggerSessionLink,
      ),
      { createOverflowLink: options?.createOverflowLink },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.logWarning("Failed to replace message with final text", errMsg);
    reportUserFacingError(err, {
      domain: "chat_platform",
      surface: "final_response",
      operation: "replace_final_response",
      severity: "error",
      platform: options?.platform,
      context: {
        sessionConversation: options?.sessionConversation,
        sessionUuid: options?.sessionUuid,
        finalTextLength: finalText.length,
      },
    });
  }
}

interface UsageReportContext {
  session: MikanAgentSession;
  runState: RunnerSessionState;
  responder: ConversationResponder;
  platform: MessagingInfo;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
  sessionConversation: string;
  sessionUuid: string;
  waitForQueue: () => Promise<void>;
}

async function reportUsageSummary(ctx: UsageReportContext): Promise<void> {
  const {
    session,
    runState,
    responder,
    platform,
    model,
    agentConfig,
    sessionConversation,
    sessionUuid,
    waitForQueue,
  } = ctx;
  const lastAssistantMessage = session.messages
    .slice()
    .toReversed()
    .find(
      (message): message is Extract<typeof message, { role: "assistant" }> =>
        message.role === "assistant" && message.stopReason !== "aborted",
    );

  const contextTokens = lastAssistantMessage
    ? lastAssistantMessage.usage.input +
      lastAssistantMessage.usage.output +
      lastAssistantMessage.usage.cacheRead +
      lastAssistantMessage.usage.cacheWrite
    : 0;
  const contextWindow = model.contextWindow || 200000;

  const { totalUsage } = runState;
  const runMetricAttributes = metricAttributes({
    provider: model.provider,
    model: agentConfig.model,
    channel_id: sessionConversation,
    session_id: sessionUuid,
    stop_reason: runState.stopReason,
    llm_calls: runState.llmCallCount,
  });
  Sentry.metrics.distribution("agent.run.tokens_in", totalUsage.input, {
    attributes: runMetricAttributes,
  });
  Sentry.metrics.distribution("agent.run.tokens_out", totalUsage.output, {
    attributes: runMetricAttributes,
  });
  Sentry.metrics.distribution("agent.run.cache_read", totalUsage.cacheRead, {
    attributes: runMetricAttributes,
  });
  Sentry.metrics.distribution("agent.run.cache_write", totalUsage.cacheWrite, {
    attributes: runMetricAttributes,
  });
  Sentry.metrics.distribution("agent.run.cost", totalUsage.cost.total, {
    attributes: runMetricAttributes,
  });
  Sentry.metrics.gauge("agent.context.utilization", contextTokens / contextWindow, {
    unit: "ratio",
    attributes: runMetricAttributes,
  });

  const summary = log.logUsageSummary(
    runState.logCtx!,
    runState.totalUsage,
    contextTokens,
    contextWindow,
  );
  if (platform.diagnostics?.showUsageSummary === true) {
    runState.queue!.enqueue(
      () => responder.respondDiagnostic(summary, { style: "muted" }),
      "usage summary",
    );
    await waitForQueue();
  }
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (
    result &&
    typeof result === "object" &&
    "content" in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const content = (result as { content: Array<{ type: string; text?: string }> }).content;
    const textParts: string[] = [];
    for (const part of content) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      }
    }
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  return JSON.stringify(result);
}

function buildThreadSessionName(message: ThreadRootMessage | null): string | undefined {
  const text = message?.text?.trim();
  if (!text) return undefined;
  const userLabel = message?.userName || message?.user || "unknown";
  return `[${userLabel}]: ${text}`;
}

interface RunnerExecutionContext {
  executionResolver?: ActorExecutionResolver;
  executor: Executor;
  getPathContext: () => RuntimePathContext;
  resolveExecutorForRun(context: {
    platform: string;
    userId: string;
    conversationId: string;
    trustModel?: PlatformTrustModel;
  }): Promise<void>;
}

interface PreparedRunContext {
  sessionConversation: string;
  runQueue: ReturnType<typeof createRunQueue>;
  userMessage: string;
  imageAttachments: ImageContent[];
  triggerAttribution?: string;
}

interface ConfiguredAgentSession {
  session: MikanAgentSession;
  /** Skills contributed by extensions, merged into each run's system prompt. */
  extensionSkills: MikanSkill[];
  /** Registry backing extension command dispatch for this harness instance. */
  extensionRegistry: ExtensionRegistry;
  /** Runs extension disposers; call once when the runner is discarded. */
  disposeExtensions: () => Promise<void>;
}

function createRunnerExecutionContext(
  sandboxConfig: SandboxConfig,
  vaultManager: VaultManager | undefined,
  provisioner: DockerContainerManager | undefined,
  workspaceDir: string,
  hostWorkspacePath: string,
): RunnerExecutionContext {
  const executionResolver =
    vaultManager && sandboxConfig.type !== "host"
      ? new ActorExecutionResolver(
          sandboxConfig,
          vaultManager,
          provisioner,
          workspaceDir,
          hostWorkspacePath,
        )
      : undefined;

  // activeExecutor is replaced at the start of each run() call when executionResolver
  // is present, so the stable `executor` wrapper always delegates to the latest resolved value.
  let activeExecutor: Executor =
    executionResolver !== undefined
      ? createExecutor({ type: "host" })
      : createExecutor(sandboxConfig);
  const executor: Executor = {
    exec(command, options) {
      return activeExecutor.exec(command, options);
    },
    readFile(path, options) {
      return activeExecutor.readFile(path, options);
    },
    writeFile(path, content, options) {
      return activeExecutor.writeFile(path, content, options);
    },
    getWorkspacePath(hostPath) {
      return activeExecutor.getWorkspacePath(hostPath);
    },
    getSandboxConfig() {
      return activeExecutor.getSandboxConfig();
    },
    getPathContext(hostWorkspaceRoot) {
      return activeExecutor.getPathContext(hostWorkspaceRoot);
    },
  };

  return {
    executionResolver,
    executor,
    getPathContext: () => executor.getPathContext(hostWorkspacePath),
    async resolveExecutorForRun(context): Promise<void> {
      if (!executionResolver) return;
      activeExecutor = await executionResolver.resolve(context);
    },
  };
}

/**
 * Extension host services over mikan's runtime infrastructure: schedules
 * become event files under `<workspaceDir>/events` (picked up live by
 * EventsWatcher), secrets come from `vaults/extensions/<slug>/env`, and
 * notify posts through the platform bots when main.ts provides a notifier.
 */
function buildExtensionHostServices(params: {
  workspaceDir: string;
  vaultManager?: VaultManager;
  platformNotifier?: PlatformNotifier;
  platformReactor?: PlatformReactor;
  platformUploader?: PlatformUploader;
}): ExtensionHostServices {
  const { workspaceDir, vaultManager, platformNotifier, platformReactor, platformUploader } =
    params;
  const eventStore = HostEventStore.fromWorkspaceDir(workspaceDir);
  return {
    stateDir: readEnv("STATE_DIR"),
    scheduleStore: {
      write: async (filename, payload) => {
        // Event files tolerate a missing platform (single-platform default),
        // so the harness payload is a valid event payload as written.
        await eventStore.write(filename, payload as unknown as MikanEvent);
      },
      delete: async (filename) => (await eventStore.delete(filename)).deleted,
      list: async () =>
        (await eventStore.list())
          .filter((entry) => entry.payload !== null)
          .map((entry) => ({
            filename: entry.filename,
            payload: entry.payload as unknown as ExtensionSchedulePayload,
          })),
    },
    ...(platformNotifier ? { postMessage: platformNotifier } : {}),
    ...(platformReactor ? { addReaction: platformReactor } : {}),
    ...(platformUploader ? { uploadFile: platformUploader } : {}),
    ...(vaultManager
      ? {
          resolveSecrets: (slug: string) => vaultManager.resolve(`extensions/${slug}`)?.env ?? {},
        }
      : {}),
  };
}

async function createConfiguredAgentSession(params: {
  conversationId: string;
  workspaceDir: string;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: Awaited<ReturnType<typeof createMikanTools>>["tools"];
  sessionStore: SessionStore;
  models: MikanModels;
  vaultManager?: VaultManager;
  platformNotifier?: PlatformNotifier;
  platformReactor?: PlatformReactor;
  platformUploader?: PlatformUploader;
}): Promise<ConfiguredAgentSession> {
  const {
    conversationId,
    workspaceDir,
    systemPrompt,
    model,
    thinkingLevel,
    tools,
    sessionStore,
    models,
    vaultManager,
    platformNotifier,
    platformReactor,
    platformUploader,
  } = params;

  // Host-only dirs under the state dir: extension code runs in the mikan
  // process, so it must never load from workspace paths — those are mounted
  // into sandbox containers and agent-writable (sandbox escape otherwise).
  const extensionsResult = await loadExtensions({
    dirs: defaultExtensionDirs(conversationId, readEnv("STATE_DIR")),
    context: { conversationId, workspaceDir, model, thinkingLevel },
    services: buildExtensionHostServices({
      workspaceDir,
      vaultManager,
      platformNotifier,
      platformReactor,
      platformUploader,
    }),
  });
  for (const err of extensionsResult.errors) {
    log.logWarning(`[${conversationId}] Extension load error: ${err.path}`, err.error);
  }
  if (extensionsResult.extensions.length > 0) {
    log.logInfo(
      `[${conversationId}] Loaded ${extensionsResult.extensions.length} extension(s): ${extensionsResult.extensions.map((extension) => extension.name).join(", ")}`,
    );
  }

  const session = new MikanAgentSession({
    systemPrompt,
    model,
    thinkingLevel,
    tools,
    models,
    sessionStore,
    extensions: extensionsResult.registry,
  });

  const reloaded = session.reloadFromSession();
  if (reloaded > 0) {
    log.logInfo(`[${conversationId}] Reloaded ${reloaded} messages from session context`);
  }
  return {
    session,
    extensionSkills: extensionsResult.skills,
    extensionRegistry: extensionsResult.registry,
    disposeExtensions: extensionsResult.dispose,
  };
}

function reloadSessionMessages(session: MikanAgentSession, conversationId: string): void {
  const reloaded = session.reloadFromSession();
  if (reloaded > 0) {
    log.logInfo(`[${conversationId}] Reloaded ${reloaded} messages from context`);
  }
}

async function prepareRunContext(params: {
  message: ConversationMessage;
  responder: ConversationResponder;
  platform: MessagingInfo;
  conversationId: string;
  conversationDir: string;
  sessionUuid: string;
  runState: RunnerSessionState;
  executor: Executor;
  executionResolver?: ActorExecutionResolver;
  resolveExecutorForRun: RunnerExecutionContext["resolveExecutorForRun"];
  getPathContext: () => RuntimePathContext;
  session: MikanAgentSession;
  extensionSkills?: MikanSkill[];
  setEventContext: (context: {
    platform: string;
    conversationId: string;
    conversationKind: ConversationKind;
    userId: string;
  }) => void;
  setSandboxContext: (context: { conversationId: string; userId: string }) => void;
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
  setReactFunction: (fn: ((emoji: string) => Promise<void>) | null) => void;
  bindPlatformToolPacks: (ctx: { conversationId: string; platformName: string }) => void;
  pathContext: RuntimePathContext;
}): Promise<PreparedRunContext & { pathContext: RuntimePathContext }> {
  const {
    message,
    responder,
    platform,
    conversationId,
    conversationDir,
    sessionUuid,
    runState,
    executor,
    executionResolver,
    resolveExecutorForRun,
    getPathContext,
    session,
    setEventContext,
    setSandboxContext,
    setUploadFunction,
    setReactFunction,
    bindPlatformToolPacks,
  } = params;
  let pathContext = params.pathContext;
  const sessionConversation = conversationIdOf(message.sessionKey);

  await mkdir(join(conversationDir, "scratch"), { recursive: true });

  if (executionResolver) {
    await resolveExecutorForRun({
      platform: platform.name,
      userId: message.userId,
      conversationId,
      trustModel: platform.trustModel,
    });
    pathContext = getPathContext();
  }

  reloadSessionMessages(session, conversationId);

  const memory = await getMemory(conversationDir);
  const skills = mergeExtensionSkills(
    loadMikanSkills(conversationDir, pathContext.runtimeWorkspaceRoot),
    params.extensionSkills ?? [],
  );
  const triggerAttribution = resolveTriggerAttribution(message);
  const systemPrompt = buildSystemPrompt(
    pathContext.runtimeWorkspaceRoot,
    conversationId,
    message.conversationKind,
    message.userId,
    memory,
    executor.getSandboxConfig(),
    platform,
    skills,
  );
  session.agent.state.systemPrompt = systemPrompt;
  // Cache diagnosis: a byte-stable system prompt is the precondition for
  // provider prompt caching. If this hash changes between turns of one
  // conversation, something turn-varying leaked into the prompt; if it is
  // stable and cacheRead stays 0, the miss is provider-side (e.g. OpenRouter
  // routing the model across upstream hosts). This is the base prompt mikan
  // builds; a `before_agent_start` extension may still rewrite it per turn
  // (logged separately by the runner).
  const promptHash = createHash("sha256").update(systemPrompt).digest("hex").slice(0, 8);
  log.logInfo(
    `[${conversationId}] System prompt (base): ${systemPrompt.length} chars, sha ${promptHash}`,
  );

  setEventContext({
    platform: platform.name,
    conversationId,
    conversationKind: message.conversationKind,
    userId: message.userId,
  });
  setSandboxContext({ conversationId, userId: message.userId });

  setUploadFunction(async (filePath: string, title?: string) => {
    const hostPath = translateAttachPathToHost(filePath, pathContext);
    await responder.uploadFile(hostPath, title);
  });

  // The react tool is available only when the responder supports reactions
  // (interactive turns on platforms with reaction support); otherwise unset
  // so the tool reports it is unavailable rather than silently no-op'ing.
  setReactFunction(responder.react ? async (emoji: string) => responder.react!(emoji) : null);

  // Platform capability packs (e.g. GitHub PR/CI) enable themselves per run;
  // core does not branch on platform name here.
  bindPlatformToolPacks({ conversationId, platformName: platform.name });

  resetRunState(
    runState,
    responder,
    sessionConversation,
    message.userName,
    sessionUuid,
    triggerAttribution,
  );
  const runQueue = createRunQueue(responder, runState);
  runState.queue = runQueue.queue;

  log.logInfo(
    `Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`,
  );
  log.logInfo(`Channels: ${platform.channels.length}, Users: ${platform.users.length}`);

  const { userMessage, imageAttachments } = buildPromptPayload(
    message,
    pathContext.runtimeWorkspaceRoot,
    pathContext,
  );
  const turnInstructions = buildTurnInstructions(
    message.id.startsWith("event:"),
    triggerAttribution,
    platform.name,
  );
  const finalUserMessage = turnInstructions ? `${turnInstructions}\n\n${userMessage}` : userMessage;
  return {
    sessionConversation,
    runQueue,
    userMessage: finalUserMessage,
    imageAttachments,
    triggerAttribution,
    pathContext,
  };
}

function formatAgentActorName(userName: string | undefined, fallback: string): string {
  return userName ? `DM:${userName}` : fallback;
}

function sendAgentEvent(payload: {
  sessionId: string;
  actorName: string;
  event: AgentEventPayload;
}): void {
  emitAgentEvent({ source: "mikan", ...payload });
}

// ponytail: additive SSE mirror only; keep responder rendering here until another frontend needs the same stream.
function attachSessionEventHandlers(params: {
  session: MikanAgentSession;
  runState: RunnerSessionState;
  model: Model<Api>;
  agentConfig: ReturnType<typeof resolveConversationSettings>;
}): void {
  const { session, runState, model, agentConfig } = params;
  session.subscribe(async (event) => {
    if (!runState.responder || !runState.logCtx || !runState.queue) return;

    const { responder, logCtx, queue, pendingTools } = runState;
    const baseAttrs = { channel_id: logCtx.conversationId, session_id: logCtx.sessionId };
    const agentEventSessionId = logCtx.sessionId ?? logCtx.conversationId;

    if (event.type === "tool_execution_start") {
      const args = (event.args ?? {}) as { label?: string };
      const label = args.label || event.toolName;
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: {
          kind: "toolStart",
          toolId: event.toolCallId,
          toolName: event.toolName,
          input: { label },
        },
      });

      pendingTools.set(event.toolCallId, {
        toolName: event.toolName,
        args: event.args,
        startTime: Date.now(),
      });
      runState.toolProgress.set(event.toolCallId, {
        label: extractToolLabel(event.toolName, event.args),
        status: "running",
      });
      queue.enqueue(
        () => replaceResponseWithToolProgress(responder, runState),
        "tool progress update",
      );
      addLifecycleBreadcrumb("agent.tool.started", {
        tool: event.toolName,
        ...baseAttrs,
      });

      log.logToolStart(logCtx, event.toolName, label, event.args as Record<string, unknown>);
      return;
    }

    if (event.type === "tool_execution_end") {
      const resultStr = extractToolResultText(event.result);
      const pending = pendingTools.get(event.toolCallId);
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: { kind: "toolEnd", toolId: event.toolCallId },
      });
      const progress = runState.toolProgress.get(event.toolCallId);
      if (progress) progress.status = event.isError ? "error" : "done";
      queue.enqueue(
        () => replaceResponseWithToolProgress(responder, runState),
        "tool progress update",
      );
      pendingTools.delete(event.toolCallId);
      const durationMs = pending ? Date.now() - pending.startTime : 0;

      Sentry.metrics.count("agent.tool.calls", 1, {
        attributes: metricAttributes({
          tool: event.toolName,
          error: String(event.isError),
          ...baseAttrs,
        }),
      });
      Sentry.metrics.distribution("agent.tool.duration", durationMs, {
        unit: "millisecond",
        attributes: metricAttributes({
          tool: event.toolName,
          ...baseAttrs,
        }),
      });
      addLifecycleBreadcrumb("agent.tool.completed", {
        tool: event.toolName,
        error: event.isError,
        duration_ms: durationMs,
        ...baseAttrs,
      });

      if (event.isError) {
        log.logToolError(logCtx, event.toolName, durationMs, resultStr);
      } else {
        log.logToolSuccess(logCtx, event.toolName, durationMs, resultStr);
      }

      return;
    }

    if (event.type === "message_start") {
      if (event.message.role === "assistant") {
        runState.llmCallCount += 1;
        sendAgentEvent({
          sessionId: agentEventSessionId,
          actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
          event: { kind: "sessionStart" },
        });
        addLifecycleBreadcrumb("agent.llm.call.started", {
          call_index: runState.llmCallCount,
          provider: model.provider,
          model: agentConfig.model,
          ...baseAttrs,
        });
        log.logResponseStart(logCtx);
      }
      return;
    }

    if (event.type === "message_update") {
      const assistantMessageEvent = (
        event as {
          assistantMessageEvent?: { type?: string; delta?: string };
        }
      ).assistantMessageEvent;
      if (assistantMessageEvent?.type === "text_delta" && assistantMessageEvent.delta) {
        sendAgentEvent({
          sessionId: agentEventSessionId,
          actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
          event: { kind: "responseDelta", delta: assistantMessageEvent.delta },
        });
        if (responder.appendResponseDelta) {
          queue.enqueue(async () => {
            await responder.appendResponseDelta?.(assistantMessageEvent.delta ?? "");
          }, "response delta");
        }
      }
      return;
    }

    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        const assistantMsg = event.message;

        if (assistantMsg.stopReason) {
          runState.stopReason = assistantMsg.stopReason;
        }
        if (assistantMsg.errorMessage) {
          runState.errorMessage = assistantMsg.errorMessage;
        }

        if (assistantMsg.usage) {
          runState.totalUsage.input += assistantMsg.usage.input;
          runState.totalUsage.output += assistantMsg.usage.output;
          runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
          runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
          runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
          runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
          runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
          runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
          runState.totalUsage.cost.total += assistantMsg.usage.cost.total;

          const llmAttributes = metricAttributes({
            provider: model.provider,
            model: agentConfig.model,
            ...baseAttrs,
            stop_reason: assistantMsg.stopReason,
            error: Boolean(assistantMsg.errorMessage),
          });
          Sentry.metrics.count("agent.llm.calls", 1, { attributes: llmAttributes });
          Sentry.metrics.distribution("agent.llm.tokens_in", assistantMsg.usage.input, {
            attributes: llmAttributes,
          });
          Sentry.metrics.distribution("agent.llm.tokens_out", assistantMsg.usage.output, {
            attributes: llmAttributes,
          });
          if (assistantMsg.usage.cacheRead > 0) {
            Sentry.metrics.distribution("agent.llm.cache_read", assistantMsg.usage.cacheRead, {
              attributes: llmAttributes,
            });
          }
          if (assistantMsg.usage.cacheWrite > 0) {
            Sentry.metrics.distribution("agent.llm.cache_write", assistantMsg.usage.cacheWrite, {
              attributes: llmAttributes,
            });
          }
          Sentry.metrics.distribution("agent.llm.cost_per_turn", assistantMsg.usage.cost.total, {
            attributes: llmAttributes,
          });
          addLifecycleBreadcrumb("agent.llm.call.completed", {
            call_index: runState.llmCallCount,
            provider: model.provider,
            model: agentConfig.model,
            stop_reason: assistantMsg.stopReason,
            error: Boolean(assistantMsg.errorMessage),
            input_tokens: assistantMsg.usage.input,
            output_tokens: assistantMsg.usage.output,
            cost_total_usd: assistantMsg.usage.cost.total,
          });
        }

        const thinkingParts: string[] = [];
        const textParts: string[] = [];
        const hasToolCall = assistantMsg.content.some((part) =>
          ["tool_use", "toolCall", "tool-call"].includes((part as { type?: string }).type ?? ""),
        );
        for (const part of assistantMsg.content) {
          if (part.type === "thinking") {
            thinkingParts.push(part.thinking);
          } else if (part.type === "text") {
            textParts.push(part.text);
          }
        }

        const text = textParts.join("\n");

        for (const thinking of thinkingParts) {
          log.logThinking(logCtx, thinking);
          queue.enqueue(() => responder.respond(`_${thinking}_`), "thinking main");
          queue.enqueue(() => responder.respondDiagnostic(`_${thinking}_`), "thinking diagnostic");
        }

        if (text.trim() && !hasToolCall) {
          if (runState.finalResponseHandledByTool) return;
          const finalText = appendTriggerAttribution(
            formatResponseWithToolProgress(text, runState),
            runState.triggerAttribution,
          );
          log.logResponse(logCtx, text);
          sendAgentEvent({
            sessionId: agentEventSessionId,
            actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
            event: { kind: "responseFinal", text: finalText },
          });
          sendAgentEvent({
            sessionId: agentEventSessionId,
            actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
            event: { kind: "turnEnd" },
          });
          if (responder.finishResponse) {
            queue.enqueue(async () => {
              await responder.finishResponse?.(finalText);
            }, "response finish");
          } else {
            queue.enqueue(() => responder.respond(finalText), "response main");
          }
        }
      }
      return;
    }

    if (event.type === "compaction_start") {
      const text = "_Compacting context..._";
      log.logInfo(`Auto-compaction started (reason: ${event.reason})`);
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: { kind: "diagnostic", text },
      });
      queue.enqueue(() => responder.respond(text), "compaction start");
      return;
    }

    if (event.type === "compaction_end") {
      if (event.result) {
        log.logInfo(`Auto-compaction complete: ${event.result.tokensBefore} tokens compacted`);
      } else if (event.aborted) {
        log.logInfo("Auto-compaction aborted");
      }
      return;
    }

    if (event.type === "auto_retry_start") {
      log.logWarning(`Retrying (${event.attempt}/${event.maxAttempts})`, event.errorMessage);
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: { kind: "sessionStart" },
      });
      const text = `_Retrying (${event.attempt}/${event.maxAttempts})..._`;
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: { kind: "diagnostic", text },
      });
      queue.enqueue(() => responder.respond(text), "retry");
    }

    if (event.type === "budget_exceeded") {
      log.logWarning(
        "Run stopped by budget circuit breaker",
        `${event.reason} (tokens=${event.tokens}, cost=${event.costUsd.toFixed(2)}, calls=${event.llmCalls}, ${event.durationMs}ms)`,
      );
      const text = `_Stopped: run budget exceeded (${event.reason})_`;
      sendAgentEvent({
        sessionId: agentEventSessionId,
        actorName: formatAgentActorName(logCtx.userName, logCtx.conversationId),
        event: { kind: "diagnostic", text },
      });
      queue.enqueue(() => responder.respondDiagnostic(text, { style: "error" }), "budget exceeded");
    }
  });
}

export interface CreateRunnerOptions {
  sandboxConfig: SandboxConfig;
  sessionKey: string;
  conversationId: string;
  conversationDir: string;
  workspaceDir: string;
  sessionScope: ResolvedSessionScope;
  vaultManager?: VaultManager;
  provisioner?: DockerContainerManager;
  resourceController?: SandboxResourceController;
  sessionView?: {
    tokenStore: SessionViewTokenStoreLike;
    portalBaseUrl?: string;
  };
  platformNotifier?: PlatformNotifier;
  platformReactor?: PlatformReactor;
  platformUploader?: PlatformUploader;
  platformToolPackFactories?: readonly PlatformToolPackFactory[];
  /** Model registry override; defaults to the process-wide models.json load. */
  models?: MikanModels;
}

/**
 * Create a new PiAgentWrapper for a channel.
 * Sets up the session and subscribes to events once.
 *
 * Runner caching is handled by the caller (channelStates in main.ts).
 * This is a stateless factory function.
 */
export async function createRunner(options: CreateRunnerOptions): Promise<PiAgentWrapper> {
  const {
    sandboxConfig,
    sessionKey,
    conversationId,
    conversationDir,
    workspaceDir,
    sessionScope,
    vaultManager,
    provisioner,
    resourceController,
    sessionView,
    platformNotifier,
    platformReactor,
    platformUploader,
    platformToolPackFactories,
  } = options;
  const agentConfig = resolveConversationSettings(conversationDir);

  const workspaceBase = join(conversationDir, "..");
  const { executionResolver, executor, getPathContext, resolveExecutorForRun } =
    createRunnerExecutionContext(
      sandboxConfig,
      vaultManager,
      provisioner,
      workspaceDir,
      workspaceBase,
    );
  let pathContext = getUnresolvedSandboxPathContext(sandboxConfig, workspaceBase);

  const modelRegistry = options.models ?? MikanModels.create();
  if (modelRegistry.getError()) {
    log.logWarning("models.json load error", modelRegistry.getError()!);
  }
  const model = modelRegistry.resolve(agentConfig.provider, agentConfig.model);

  // Create tools (per-runner, with per-runner upload function setter)
  const {
    tools,
    setUploadFunction,
    setReactFunction,
    bindPlatformToolPacks,
    setEventContext,
    setSandboxContext,
  } = createMikanTools(
    executor,
    workspaceDir,
    { sandbox: sandboxConfig, resourceController: resourceController ?? provisioner },
    platformToolPackFactories ?? [],
    {
      model,
      getApiKey: () => modelRegistry.getApiKeyForProvider(model.provider),
    },
  );

  // Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
  const memory = await getMemory(conversationDir);
  const skills = loadMikanSkills(conversationDir, pathContext.runtimeWorkspaceRoot);
  const emptyPlatform: MessagingInfo = {
    name: "chat",
    formattingGuide: "",
    channels: [],
    users: [],
    trustModel: "membership",
  };
  const systemPrompt = buildSystemPrompt(
    pathContext.runtimeWorkspaceRoot,
    conversationId,
    "shared",
    undefined,
    memory,
    sandboxConfig,
    emptyPlatform,
    skills,
  );

  // Create session manager and settings manager. Top-level/private sessions
  // use the conversation's current pointer; scoped sessions use fixed files.
  // Platform-specific scope behavior is resolved before runner creation.
  const isThread = isThreadSessionKey(sessionKey);
  const { contextFile, threadRootMessage } = sessionScope;
  const sessionManager = openManagedSession(contextFile, pathContext.runtimeWorkspaceRoot);
  const threadSessionName = buildThreadSessionName(threadRootMessage);
  if (isThread && threadSessionName && sessionManager.getSessionName() !== threadSessionName) {
    sessionManager.appendSessionInfo(threadSessionName);
  }

  const sessionUuid = extractSessionUuid(contextFile);
  const chatSessionManager = new AgentMemoryFileManager();
  const { session, extensionSkills, extensionRegistry, disposeExtensions } =
    await createConfiguredAgentSession({
      conversationId,
      workspaceDir,
      systemPrompt,
      model,
      thinkingLevel: agentConfig.thinkingLevel,
      tools,
      sessionStore: sessionManager,
      models: modelRegistry,
      vaultManager,
      platformNotifier,
      platformReactor,
      platformUploader,
    });

  // Mutable per-run state - event handler references this
  const runState = createRunState();
  attachSessionEventHandlers({ session, runState, model, agentConfig });

  return {
    syncChatHistory(currentMessageId?: string): void {
      chatSessionManager.syncSessionManager({
        conversationDir,
        sessionKey,
        sessionManager,
        currentMessageId,
      });
    },

    async run(
      message: ConversationMessage,
      responder: ConversationResponder,
      platform: MessagingInfo,
    ): Promise<{ stopReason: string; errorMessage?: string }> {
      const prepared = await prepareRunContext({
        message,
        responder,
        platform,
        conversationId,
        conversationDir,
        sessionUuid,
        runState,
        executor,
        executionResolver,
        resolveExecutorForRun,
        getPathContext,
        session,
        extensionSkills,
        setEventContext,
        setSandboxContext,
        setUploadFunction,
        setReactFunction,
        bindPlatformToolPacks,
        pathContext,
      });
      pathContext = prepared.pathContext;

      if (runState.logCtx) {
        log.logAgentRunStart(runState.logCtx, model.provider, model.id, model.name);
      }

      updateActiveSpanAttribution({
        provider: model.provider,
        model: agentConfig.model,
        channel_id: prepared.sessionConversation,
        session_id: sessionUuid,
      });
      addLifecycleBreadcrumb("agent.prompt.sent", {
        provider: model.provider,
        model: agentConfig.model,
        channel_id: prepared.sessionConversation,
        session_id: sessionUuid,
        attachment_count: message.attachments?.length ?? 0,
        image_attachment_count: prepared.imageAttachments.length,
      });
      sendAgentEvent({
        sessionId: sessionUuid,
        actorName: formatAgentActorName(message.userName, prepared.sessionConversation),
        event: { kind: "sessionStart" },
      });

      // Autonomous (event/trigger) runs get an explicit resource ceiling since
      // no human is watching the loop; interactive turns stay human-gated.
      const isEventRun = message.id.startsWith("event:");
      // Event runs have no triggering platform message, so identity fields
      // stay unset and extensions must null-check them.
      const origin: RunOrigin = isEventRun
        ? { kind: "event", platform: platform.name }
        : {
            kind: "interactive",
            platform: platform.name,
            messageTs: message.id,
            userId: message.userId,
            userName: message.userName,
            threadTs: message.threadTs,
            attachments: message.attachments,
          };
      const outcome = await session.prompt(prepared.userMessage, {
        origin,
        ...(prepared.imageAttachments.length > 0 ? { images: prepared.imageAttachments } : {}),
        ...(isEventRun ? { budget: DEFAULT_EVENT_BUDGET } : {}),
      });

      if (outcome?.blocked) {
        const text = outcome.reason
          ? `_Turn blocked by an extension: ${outcome.reason}_`
          : "_Turn blocked by an extension._";
        sendAgentEvent({
          sessionId: sessionUuid,
          actorName: formatAgentActorName(message.userName, prepared.sessionConversation),
          event: { kind: "diagnostic", text },
        });
        await responder.respondDiagnostic(text, { style: "muted" });
        runState.responder = null;
        runState.logCtx = null;
        runState.queue = null;
        return { stopReason: "blocked" };
      }

      // Wait for queued messages
      await prepared.runQueue.wait();

      const sessionViewTokenStore = sessionView?.tokenStore;
      const sessionViewPortalBaseUrl = sessionView?.portalBaseUrl;
      let sessionViewLink: string | undefined;
      const createSessionViewLink =
        sessionViewTokenStore && sessionViewPortalBaseUrl
          ? () => {
              if (!sessionViewLink) {
                const token = sessionViewTokenStore.create(
                  platform.name as PlatformName,
                  message.userId,
                  conversationId,
                  message.sessionKey,
                  contextFile,
                  message.userName,
                );
                sessionViewLink = `${sessionViewPortalBaseUrl}/session?token=${token.token}`;
              }
              return sessionViewLink;
            }
          : undefined;

      await finalizeRunResponse(responder, session, runState, {
        triggerAttribution: prepared.triggerAttribution,
        triggerSessionLink: isEventTriggerAttribution(prepared.triggerAttribution)
          ? createSessionViewLink?.()
          : undefined,
        createOverflowLink: createSessionViewLink,
        platform: platform.name,
        model,
        sessionConversation: prepared.sessionConversation,
        sessionUuid,
      });

      await reportUsageSummary({
        session,
        runState,
        responder,
        platform,
        model,
        agentConfig,
        sessionConversation: prepared.sessionConversation,
        sessionUuid,
        waitForQueue: () => prepared.runQueue.wait(),
      });

      // Clear run state
      runState.responder = null;
      runState.logCtx = null;
      runState.queue = null;

      return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
    },

    abort(): void {
      session.abort();
    },

    async tryExtensionCommand(
      message: ConversationMessage,
      responder: ConversationResponder,
    ): Promise<boolean> {
      const parsed = parseCommandInput(message.text);
      if (!parsed) return false;
      return extensionRegistry.dispatchCommand(parsed.name, {
        args: parsed.args,
        conversationId,
        userId: message.userId,
        userName: message.userName,
        respond: (text: string) => responder.respond(text),
      });
    },

    async dispose(): Promise<void> {
      await disposeExtensions();
    },

    getCurrentStep(): { toolName?: string; label?: string } | undefined {
      const pending = runState.pendingTools;
      if (pending.size === 0) return undefined;
      // Get the first pending tool
      const first = pending.values().next().value;
      if (!first) return undefined;
      return {
        toolName: first.toolName,
        label: (first.args as { label?: string })?.label,
      };
    },
  };
}
