import type { ConversationMessage, ConversationKind, MessagingInfo } from "../adapter.js";
import { formatSkillsForPrompt, loadSkillsFromDir, type MikanSkill } from "../harness/index.js";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, posix } from "path";
import * as log from "../log.js";
import type { SandboxConfig } from "../sandbox/index.js";

export async function getMemory(conversationDir: string): Promise<string> {
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

export function loadMikanSkills(conversationDir: string, workspacePath: string): MikanSkill[] {
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

export function buildSystemPrompt(
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

export function mergeExtensionSkills(local: MikanSkill[], extension: MikanSkill[]): MikanSkill[] {
  if (extension.length === 0) return local;
  const byName = new Map<string, MikanSkill>();
  for (const skill of extension) byName.set(skill.name, skill);
  for (const skill of local) byName.set(skill.name, skill);
  return [...byName.values()];
}
