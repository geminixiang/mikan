import { Agent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getModel, type Api, type ImageContent, type Model } from "@earendil-works/pi-ai";
import {
  AgentSession,
  AuthStorage,
  convertToLlm,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  getAgentDir,
  loadSkillsFromDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, posix } from "path";
import type {
  ChatMessage,
  ChatResponseContext,
  ChatToolResult,
  ConversationKind,
  PlatformInfo,
  PlatformName,
} from "./adapter.js";
import type { SessionViewTokenStoreLike } from "./commands/types.js";
import { loadAgentConfigForConversation } from "./config.js";
import { ActorExecutionResolver } from "./execution-resolver.js";
import * as log from "./log.js";
import { reportUserFacingError } from "./sentry.js";
import type { DockerContainerManager } from "./provisioner.js";
import {
  createExecutor,
  type Executor,
  type RuntimePathContext,
  type SandboxConfig,
} from "./sandbox/index.js";
import { createMountedRuntimePathContext } from "./sandbox/path-context.js";
import { addLifecycleBreadcrumb, metricAttributes } from "./sentry.js";
import type { VaultManager } from "./vault.js";
import {
  extractSessionUuid,
  openManagedSession,
  type ResolvedSessionScope,
  type ThreadRootMessage,
} from "./sessions/store.js";
import { shouldSurfaceToolDiagnostic } from "./tool-diagnostics.js";
import { createMamaTools } from "./tools/index.js";
import * as Sentry from "@sentry/node";

export interface AgentRunner {
  run(
    message: ChatMessage,
    responseCtx: ChatResponseContext,
    platform: PlatformInfo,
  ): Promise<{ stopReason: string; errorMessage?: string }>;
  abort(): void;
  /** Get current step info (tool name, label) for debugging */
  getCurrentStep(): { toolName?: string; label?: string } | undefined;
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

function buildThreadSessionName(message: ThreadRootMessage | null): string | undefined {
  const text = message?.text?.trim();
  if (!text) return undefined;
  const userLabel = message?.userName || message?.user || "unknown";
  return `[${userLabel}]: ${text}`;
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

function loadMamaSkills(conversationDir: string, workspacePath: string): Skill[] {
  const skillMap = new Map<string, Skill>();

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

export function buildEventFilesystemInstructions(
  sandboxType: SandboxConfig["type"],
  workspaceRoot: string,
): string {
  if (sandboxType === "host" || sandboxType === "container" || sandboxType === "image") {
    return `Events live in the host-side mama control plane and are mounted at \`${workspaceRoot}/events/\` in this runtime.

Prefer the \`event\` tool over manually writing JSON files; it fills \`platform\`, \`conversationId\`, \`conversationKind\`, and \`userId\` for the current conversation automatically.

### Creating Events Manually
Only do this when you need to create events from a script. Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspaceRoot}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "platform": "<platform>", "conversationId": "<conversationId>", "conversationKind": "<direct|shared>", "userId": "<requester userId>", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`

### Managing Events
- List: \`ls ${workspaceRoot}/events/\`
- View: \`cat ${workspaceRoot}/events/foo.json\`
- Delete/cancel: \`rm ${workspaceRoot}/events/foo.json\``;
  }

  return `Events live in the host-side mama control plane, not necessarily in this runtime filesystem.

Use the \`event\` tool to create events. It writes to the correct host-side events directory and fills \`platform\`, \`conversationId\`, \`conversationKind\`, and \`userId\` for the current conversation automatically.

Do not create event files with bash in \`${workspaceRoot}/events/\` from this sandbox unless you have explicitly verified that path is mounted back to the host-side mama events directory.`;
}

export function resolveTriggerAttribution(
  message: Pick<ChatMessage, "id" | "text" | "userName">,
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
  platform: PlatformInfo,
  skills: Skill[],
  isEventTrigger = false,
  triggerAttribution?: string,
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
  const eventFilesystemInstructions = buildEventFilesystemInstructions(sandboxType, workspaceRoot);
  const eventTriggerInstructions = isEventTrigger
    ? `
## Event Trigger Mode
- You are handling a scheduled/background event, not opening a brand new chat with a stranger.
- Treat the incoming user message as a self-contained task prepared by an earlier run.
- Complete the task directly. Avoid generic greetings, self-introductions, or boilerplate offers to help.
- For reminders/follow-ups, prefer a short direct response that sounds like a continuation of prior intent.
- If the event text includes tone, brevity, or language instructions, follow them literally.
`
    : "";
  const attributionInstructions = triggerAttribution
    ? `
## Attribution
Always end your final ${platform.name} response and any GitHub issue/PR comments or descriptions you write via tools with:
_Triggered by ${triggerAttribution}_

Do not add this to \`[SILENT]\` responses.
`
    : "";

  return `You are mama, a ${platform.name} bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older human-readable history beyond your context, search \`log.jsonl\` (contains user messages and your final responses, but not tool results).
- Structured session history with tool results lives in \`${conversationPath}/sessions/\`.
- The active top-level session is selected by \`${conversationPath}/sessions/current\`, which points to a timestamped \`.jsonl\` file in the same directory.
- Scoped/thread sessions use fixed files at \`${conversationPath}/sessions/<scope_id>.jsonl\` (for example \`${conversationPath}/sessions/1777386320.800769.jsonl\`).
- If a user asks about something that should exist in conversation history but is not found in the current context window, do not answer "I don't know" or "I don't have that". Instead, search the thread session, top-level session, and \`log.jsonl\` before responding.
- User messages include a \`[in-thread:TS]\` marker when sent from within a platform thread/reply (TS is the thread or parent message identifier). Without this marker, the message is a top-level conversation message.
${eventTriggerInstructions}
${platform.formattingGuide}

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
You can schedule events that wake you up at specific times or when external things happen.
${eventFilesystemInstructions}

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "platform": "${platform.name}", "conversationId": "${conversationId}", "conversationKind": "${conversationKind}", "userId": "${currentUserId ?? "<requester userId>"}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "platform": "${platform.name}", "conversationId": "${conversationId}", "conversationKind": "${conversationKind}", "userId": "${currentUserId ?? "<requester userId>"}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "platform": "${platform.name}", "conversationId": "${conversationId}", "conversationKind": "${conversationKind}", "userId": "${currentUserId ?? "<requester userId>"}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Platform and Credential Routing
Set \`platform\` to the target bot platform (\`${platform.name}\` for this conversation). Include it explicitly to avoid ambiguity.

Set \`userId\` to the platform userId of whoever asked for the event. When the event fires, tool execution routes using that user's vault selection in per-user modes. In \`container:<name>\`, events use the container's single shared vault.

When scheduling an event, write \`text\` as a self-contained task for your future self. Include the minimum necessary context, tone, and constraints in the text itself because events do not inherit normal conversation history. Good: \`Please remind the user that break time is over and it is time to return to class. Keep it brief, in Traditional Chinese, and do not ask follow-up questions.\` Bad: \`back to class\`.

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This deletes the status message and posts nothing to the platform. Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

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
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
Use \`log.jsonl\` for quick grep-style history. Use \`${conversationPath}/sessions/\` when you need structured turns, tool outputs, or branch lineage.
${isContainerLike || isFirecracker ? "Install jq: apt-get install jq" : ""}
${attributionInstructions}
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
- attach: Share files to the platform

Each tool requires a "label" parameter (shown to user).
`;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.substring(0, maxLen - 3)}...`;
}

export function getUnresolvedSandboxPathContext(
  sandboxConfig: SandboxConfig,
  hostWorkspaceRoot: string,
): RuntimePathContext {
  if (sandboxConfig.type === "image") {
    return createMountedRuntimePathContext(hostWorkspaceRoot, "/workspace");
  }

  return createExecutor(sandboxConfig).getPathContext(hostWorkspaceRoot);
}

interface RunnerExecutionContext {
  executionResolver?: ActorExecutionResolver;
  executor: Executor;
  getPathContext: () => RuntimePathContext;
  resolveExecutorForRun(context: {
    platform: string;
    userId: string;
    conversationId: string;
  }): Promise<void>;
}

interface RunnerSessionState {
  responseCtx: ChatResponseContext | null;
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
}

interface PreparedRunContext {
  sessionConversation: string;
  runQueue: ReturnType<typeof createRunQueue>;
  userMessage: string;
  imageAttachments: ImageContent[];
  triggerAttribution?: string;
}

interface ConfiguredAgentSession {
  agent: Agent;
  session: AgentSession;
}

function createRunnerExecutionContext(
  sandboxConfig: SandboxConfig,
  vaultManager: VaultManager | undefined,
  provisioner: DockerContainerManager | undefined,
  workspaceDir: string,
  hostWorkspacePath: string,
): RunnerExecutionContext {
  const executionResolver =
    vaultManager &&
    sandboxConfig.type !== "host" &&
    (vaultManager.isEnabled() ||
      sandboxConfig.type === "container" ||
      sandboxConfig.type === "image" ||
      sandboxConfig.type === "cloudflare" ||
      sandboxConfig.type === "firecracker")
      ? new ActorExecutionResolver(sandboxConfig, vaultManager, provisioner, workspaceDir)
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

async function createConfiguredAgentSession(params: {
  conversationId: string;
  workspaceDir: string;
  runtimeWorkspaceRoot: string;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: Awaited<ReturnType<typeof createMamaTools>>["tools"];
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
}): Promise<ConfiguredAgentSession> {
  const {
    conversationId,
    workspaceDir,
    runtimeWorkspaceRoot,
    systemPrompt,
    model,
    thinkingLevel,
    tools,
    sessionManager,
    settingsManager,
  } = params;

  const authStorage = AuthStorage.create(join(homedir(), ".pi", "mama", "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage);
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools,
    },
    convertToLlm,
    getApiKey: async () => {
      const key = await modelRegistry.getApiKeyForProvider(model.provider);
      if (!key) {
        throw new Error(
          `No API key for provider "${model.provider}". Set the appropriate environment variable or configure via auth.json`,
        );
      }
      return key;
    },
  });

  const loadedSession = sessionManager.buildSessionContext();
  if (loadedSession.messages.length > 0) {
    agent.state.messages = loadedSession.messages;
    log.logInfo(
      `[${conversationId}] Reloaded ${loadedSession.messages.length} messages from session context`,
    );
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: workspaceDir,
    agentDir: getAgentDir(),
    systemPrompt,
  });
  try {
    await resourceLoader.reload();
    const extResult = resourceLoader.getExtensions();
    if (extResult.errors.length > 0) {
      for (const err of extResult.errors) {
        log.logWarning(`[${conversationId}] Extension load error: ${err.path}`, err.error);
      }
    }
    log.logInfo(
      `[${conversationId}] Loaded ${extResult.extensions.length} extension(s): ${extResult.extensions.map((extension) => extension.path).join(", ")}`,
    );
  } catch (error) {
    log.logWarning(`[${conversationId}] Failed to load resources`, String(error));
  }

  const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    cwd: runtimeWorkspaceRoot,
    modelRegistry,
    resourceLoader,
    baseToolsOverride,
  });
  return { agent, session };
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
    responseCtx: null,
    logCtx: null,
    queue: null,
    pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
    totalUsage: createEmptyUsageTotals(),
    llmCallCount: 0,
    stopReason: "stop",
    errorMessage: undefined,
    reportedLlmError: false,
  };
}

function resetRunState(
  runState: RunnerSessionState,
  responseCtx: ChatResponseContext,
  sessionConversation: string,
  userName: string | undefined,
  sessionUuid: string,
): void {
  runState.responseCtx = responseCtx;
  runState.logCtx = {
    conversationId: sessionConversation,
    userName,
    conversationName: undefined,
    sessionId: sessionUuid,
  };
  runState.pendingTools.clear();
  runState.totalUsage = createEmptyUsageTotals();
  runState.llmCallCount = 0;
  runState.stopReason = "stop";
  runState.errorMessage = undefined;
  runState.reportedLlmError = false;
}

function createRunQueue(responseCtx: ChatResponseContext): {
  queue: { enqueue(fn: () => Promise<void>, errorContext: string): void };
  wait: () => Promise<void>;
} {
  let queueChain = Promise.resolve();
  return {
    queue: {
      enqueue(fn: () => Promise<void>, errorContext: string): void {
        queueChain = queueChain.then(async () => {
          try {
            await fn();
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.logWarning(`API error (${errorContext})`, errMsg);
            try {
              await responseCtx.respondDiagnostic(`Error: ${errMsg}`, { style: "error" });
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

function padTwoDigits(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatTimestampedUserMessage(message: ChatMessage): string {
  const now = new Date();
  const offset = -now.getTimezoneOffset();
  const offsetSign = offset >= 0 ? "+" : "-";
  const offsetHours = padTwoDigits(Math.floor(Math.abs(offset) / 60));
  const offsetMins = padTwoDigits(Math.abs(offset) % 60);
  const timestamp =
    `${now.getFullYear()}-${padTwoDigits(now.getMonth() + 1)}-${padTwoDigits(now.getDate())} ` +
    `${padTwoDigits(now.getHours())}:${padTwoDigits(now.getMinutes())}:${padTwoDigits(now.getSeconds())}` +
    `${offsetSign}${offsetHours}:${offsetMins}`;
  const threadContext = message.threadTs ? ` [in-thread:${message.threadTs}]` : "";
  return `[${timestamp}] [${message.userName || "unknown"}]${threadContext}: ${message.text}`;
}

function collectMessageAttachments(
  message: ChatMessage,
  workspacePath: string,
): { imageAttachments: ImageContent[]; nonImagePaths: string[] } {
  const imageAttachments: ImageContent[] = [];
  const nonImagePaths: string[] = [];

  for (const attachment of message.attachments || []) {
    const fullPath = `${workspacePath}/${attachment.localPath}`;
    const mimeType = getImageMimeType(attachment.localPath);

    if (mimeType && existsSync(fullPath)) {
      try {
        imageAttachments.push({
          type: "image",
          mimeType,
          data: readFileSync(fullPath).toString("base64"),
        });
      } catch {
        nonImagePaths.push(fullPath);
      }
    } else {
      nonImagePaths.push(fullPath);
    }
  }

  return { imageAttachments, nonImagePaths };
}

function buildPromptPayload(
  message: ChatMessage,
  workspacePath: string,
): {
  userMessage: string;
  imageAttachments: ImageContent[];
} {
  let userMessage = formatTimestampedUserMessage(message);
  const { imageAttachments, nonImagePaths } = collectMessageAttachments(message, workspacePath);

  if (nonImagePaths.length > 0) {
    userMessage += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;
  }

  return { userMessage, imageAttachments };
}

async function writePromptDebugContext(
  conversationDir: string,
  systemPrompt: string,
  session: AgentSession,
  userMessage: string,
  imageAttachmentCount: number,
): Promise<void> {
  const debugContext = {
    systemPrompt,
    messages: session.messages,
    newUserMessage: userMessage,
    imageAttachmentCount,
  };
  await writeFile(
    join(conversationDir, "last_prompt.jsonl"),
    JSON.stringify(debugContext, null, 2),
  );
}

function getFinalAssistantText(session: AgentSession): string {
  const lastAssistant = session.messages.filter((message) => message.role === "assistant").pop();
  return (
    lastAssistant?.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n") || ""
  );
}

export function appendTriggerAttribution(
  text: string,
  triggerAttribution: string | undefined,
): string {
  if (!triggerAttribution) return text;
  const suffix = `_Triggered by ${triggerAttribution}_`;
  if (text.trimEnd().endsWith(suffix)) return text;
  return `${text.trimEnd()}\n\n${suffix}`;
}

async function finalizeRunResponse(
  responseCtx: ChatResponseContext,
  session: AgentSession,
  runState: RunnerSessionState,
  options?: {
    triggerAttribution?: string;
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
      await responseCtx.replaceResponse("_Sorry, something went wrong_");
      await responseCtx.respondDiagnostic(`Error: ${runState.errorMessage}`, {
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
  if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
    try {
      await responseCtx.deleteResponse();
      log.logInfo("Silent response - deleted message and thread");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.logWarning("Failed to delete message for silent response", errMsg);
    }
    return;
  }

  if (!finalText.trim()) return;

  try {
    await responseCtx.replaceResponse(
      appendTriggerAttribution(finalText, options?.triggerAttribution),
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
  session: AgentSession;
  runState: RunnerSessionState;
  responseCtx: ChatResponseContext;
  platform: PlatformInfo;
  model: Model<Api>;
  agentConfig: ReturnType<typeof loadAgentConfigForConversation>;
  sessionConversation: string;
  sessionUuid: string;
  waitForQueue: () => Promise<void>;
}

async function reportUsageSummary(ctx: UsageReportContext): Promise<void> {
  const {
    session,
    runState,
    responseCtx,
    platform,
    model,
    agentConfig,
    sessionConversation,
    sessionUuid,
    waitForQueue,
  } = ctx;
  if (runState.totalUsage.cost.total <= 0) return;

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
      () => responseCtx.respondDiagnostic(summary, { style: "muted" }),
      "usage summary",
    );
    await waitForQueue();
  }
}

function reloadSessionMessages(
  sessionManager: SessionManager,
  conversationId: string,
  agent: Agent,
): void {
  const messages = sessionManager.buildSessionContext().messages;
  if (messages.length > 0) {
    agent.state.messages = messages;
    log.logInfo(`[${conversationId}] Reloaded ${messages.length} messages from context`);
  }
}

async function prepareRunContext(params: {
  message: ChatMessage;
  responseCtx: ChatResponseContext;
  platform: PlatformInfo;
  conversationId: string;
  conversationDir: string;
  sessionUuid: string;
  runState: RunnerSessionState;
  executor: Executor;
  executionResolver?: ActorExecutionResolver;
  resolveExecutorForRun: RunnerExecutionContext["resolveExecutorForRun"];
  getPathContext: () => RuntimePathContext;
  sessionManager: SessionManager;
  session: AgentSession;
  agent: Agent;
  setEventContext: (context: {
    platform: string;
    conversationId: string;
    conversationKind: ConversationKind;
    userId: string;
  }) => void;
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
  pathContext: RuntimePathContext;
}): Promise<PreparedRunContext & { pathContext: RuntimePathContext }> {
  const {
    message,
    responseCtx,
    platform,
    conversationId,
    conversationDir,
    sessionUuid,
    runState,
    executor,
    executionResolver,
    resolveExecutorForRun,
    getPathContext,
    sessionManager,
    session,
    agent,
    setEventContext,
    setUploadFunction,
  } = params;
  let pathContext = params.pathContext;
  const sessionConversation = message.sessionKey.split(":")[0];

  await mkdir(join(conversationDir, "scratch"), { recursive: true });

  if (executionResolver) {
    await resolveExecutorForRun({
      platform: platform.name,
      userId: message.userId,
      conversationId,
    });
    pathContext = getPathContext();
  }

  reloadSessionMessages(sessionManager, conversationId, agent);

  const memory = await getMemory(conversationDir);
  const skills = loadMamaSkills(conversationDir, pathContext.runtimeWorkspaceRoot);
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
    message.id.startsWith("event:"),
    triggerAttribution,
  );
  session.agent.state.systemPrompt = systemPrompt;

  setEventContext({
    platform: platform.name,
    conversationId,
    conversationKind: message.conversationKind,
    userId: message.userId,
  });

  setUploadFunction(async (filePath: string, title?: string) => {
    const hostPath = translateRuntimePathToHost(filePath, pathContext);
    await responseCtx.uploadFile(hostPath, title);
  });

  resetRunState(runState, responseCtx, sessionConversation, message.userName, sessionUuid);
  const runQueue = createRunQueue(responseCtx);
  runState.queue = runQueue.queue;

  log.logInfo(
    `Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`,
  );
  log.logInfo(`Channels: ${platform.channels.length}, Users: ${platform.users.length}`);

  const { userMessage, imageAttachments } = buildPromptPayload(
    message,
    pathContext.runtimeWorkspaceRoot,
  );
  await writePromptDebugContext(
    conversationDir,
    systemPrompt,
    session,
    userMessage,
    imageAttachments.length,
  );

  return {
    sessionConversation,
    runQueue,
    userMessage,
    imageAttachments,
    triggerAttribution,
    pathContext,
  };
}

function attachSessionEventHandlers(params: {
  session: AgentSession;
  runState: RunnerSessionState;
  model: Model<Api>;
  agentConfig: ReturnType<typeof loadAgentConfigForConversation>;
}): void {
  const { session, runState, model, agentConfig } = params;
  session.subscribe(async (event) => {
    if (!runState.responseCtx || !runState.logCtx || !runState.queue) return;

    const { responseCtx, logCtx, queue, pendingTools } = runState;
    const baseAttrs = { channel_id: logCtx.conversationId, session_id: logCtx.sessionId };

    if (event.type === "tool_execution_start") {
      const args = (event.args ?? {}) as { label?: string };
      const label = args.label || event.toolName;

      pendingTools.set(event.toolCallId, {
        toolName: event.toolName,
        args: event.args,
        startTime: Date.now(),
      });
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

      if (shouldSurfaceToolDiagnostic(event.toolName)) {
        const toolResult: ChatToolResult = {
          toolName: event.toolName,
          label: pending?.args ? (pending.args as { label?: string }).label : undefined,
          args: pending?.args as Record<string, unknown> | undefined,
          result: truncate(resultStr, TOOL_RESULT_DIAGNOSTIC_CAP),
          isError: event.isError,
          durationMs,
        };
        queue.enqueue(() => responseCtx.respondToolResult(toolResult), "tool result diagnostic");
      }

      if (event.isError && shouldSurfaceToolDiagnostic(event.toolName)) {
        queue.enqueue(
          () => responseCtx.respond(`_Error: ${truncate(resultStr, 200)}_`),
          "tool error",
        );
      }
      return;
    }

    if (event.type === "message_start") {
      if (event.message.role === "assistant") {
        runState.llmCallCount += 1;
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
          queue.enqueue(() => responseCtx.respond(`_${thinking}_`), "thinking main");
          queue.enqueue(
            () => responseCtx.respondDiagnostic(`_${thinking}_`),
            "thinking diagnostic",
          );
        }

        if (text.trim()) {
          log.logResponse(logCtx, text);
          queue.enqueue(() => responseCtx.respond(text), "response main");
        }
      }
      return;
    }

    if (event.type === "compaction_start") {
      log.logInfo(`Auto-compaction started (reason: ${event.reason})`);
      queue.enqueue(() => responseCtx.respond("_Compacting context..._"), "compaction start");
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
      queue.enqueue(
        () => responseCtx.respond(`_Retrying (${event.attempt}/${event.maxAttempts})..._`),
        "retry",
      );
    }
  });
}

// Cap raw tool output before handing it to adapters. Bash output can be MB; without
// this each adapter's splitter would fan it out into many sequential platform posts.
const TOOL_RESULT_DIAGNOSTIC_CAP = 8000;

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

/**
 * Create a new AgentRunner for a channel.
 * Sets up the session and subscribes to events once.
 *
 * Runner caching is handled by the caller (channelStates in main.ts).
 * This is a stateless factory function.
 */
export async function createRunner(
  sandboxConfig: SandboxConfig,
  sessionKey: string,
  conversationId: string,
  conversationDir: string,
  workspaceDir: string,
  sessionScope: ResolvedSessionScope,
  vaultManager?: VaultManager,
  provisioner?: DockerContainerManager,
  sessionView?: {
    tokenStore: SessionViewTokenStoreLike;
    portalBaseUrl?: string;
  },
): Promise<AgentRunner> {
  const agentConfig = loadAgentConfigForConversation(conversationDir);

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

  // Create tools (per-runner, with per-runner upload function setter)
  const { tools, setUploadFunction, setEventContext } = createMamaTools(executor, workspaceDir);

  // Resolve model from config. Config stores provider/model as user-provided strings,
  // while getModel's public overload is narrowed to generated known providers.
  const model = getModel(agentConfig.provider as never, agentConfig.model as never) as Model<Api>;

  // Initial system prompt (will be updated each run with fresh memory/channels/users/skills)
  const memory = await getMemory(conversationDir);
  const skills = loadMamaSkills(conversationDir, pathContext.runtimeWorkspaceRoot);
  const emptyPlatform: PlatformInfo = {
    name: "chat",
    formattingGuide: "",
    channels: [],
    users: [],
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
  // Platform-specific branch/fork behavior is resolved before runner creation.
  const isThread = sessionKey.includes(":");
  const { sessionDir, contextFile, threadRootMessage } = sessionScope;
  const sessionManager = openManagedSession(
    contextFile,
    sessionDir,
    pathContext.runtimeWorkspaceRoot,
  );
  const threadSessionName = buildThreadSessionName(threadRootMessage);
  if (isThread && threadSessionName && sessionManager.getSessionName() !== threadSessionName) {
    sessionManager.appendSessionInfo(threadSessionName);
  }

  const sessionUuid = extractSessionUuid(contextFile);
  const settingsManager = SettingsManager.inMemory();
  const { agent, session } = await createConfiguredAgentSession({
    conversationId,
    workspaceDir,
    runtimeWorkspaceRoot: pathContext.runtimeWorkspaceRoot,
    systemPrompt,
    model,
    thinkingLevel: agentConfig.thinkingLevel,
    tools,
    sessionManager,
    settingsManager,
  });

  // Mutable per-run state - event handler references this
  const runState = createRunState();
  attachSessionEventHandlers({ session, runState, model, agentConfig });

  return {
    async run(
      message: ChatMessage,
      responseCtx: ChatResponseContext,
      platform: PlatformInfo,
    ): Promise<{ stopReason: string; errorMessage?: string }> {
      const prepared = await prepareRunContext({
        message,
        responseCtx,
        platform,
        conversationId,
        conversationDir,
        sessionUuid,
        runState,
        executor,
        executionResolver,
        resolveExecutorForRun,
        getPathContext,
        sessionManager,
        session,
        agent,
        setEventContext,
        setUploadFunction,
        pathContext,
      });
      pathContext = prepared.pathContext;

      addLifecycleBreadcrumb("agent.prompt.sent", {
        provider: model.provider,
        model: agentConfig.model,
        channel_id: prepared.sessionConversation,
        session_id: sessionUuid,
        attachment_count: message.attachments?.length ?? 0,
        image_attachment_count: prepared.imageAttachments.length,
      });

      await session.prompt(
        prepared.userMessage,
        prepared.imageAttachments.length > 0 ? { images: prepared.imageAttachments } : undefined,
      );

      // Wait for queued messages
      await prepared.runQueue.wait();

      const sessionViewTokenStore = sessionView?.tokenStore;
      const sessionViewPortalBaseUrl = sessionView?.portalBaseUrl;
      const createOverflowLink =
        sessionViewTokenStore && sessionViewPortalBaseUrl
          ? () => {
              const token = sessionViewTokenStore.create(
                platform.name as PlatformName,
                message.userId,
                conversationId,
                message.sessionKey,
                contextFile,
                message.userName,
              );
              return `${sessionViewPortalBaseUrl}/session?token=${token.token}`;
            }
          : undefined;

      await finalizeRunResponse(responseCtx, session, runState, {
        triggerAttribution: prepared.triggerAttribution,
        createOverflowLink,
        platform: platform.name,
        model,
        sessionConversation: prepared.sessionConversation,
        sessionUuid,
      });

      await reportUsageSummary({
        session,
        runState,
        responseCtx,
        platform,
        model,
        agentConfig,
        sessionConversation: prepared.sessionConversation,
        sessionUuid,
        waitForQueue: () => prepared.runQueue.wait(),
      });

      // Clear run state
      runState.responseCtx = null;
      runState.logCtx = null;
      runState.queue = null;

      return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
    },

    abort(): void {
      session.abort();
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

export function translateRuntimePathToHost(
  runtimePath: string,
  pathContext: RuntimePathContext,
): string {
  return pathContext.runtimeToHostPath?.(runtimePath) ?? runtimePath;
}

export function buildInitialPathContextForTest(
  sandboxConfig: SandboxConfig,
  hostWorkspaceRoot: string,
): RuntimePathContext {
  return getUnresolvedSandboxPathContext(sandboxConfig, hostWorkspaceRoot);
}
