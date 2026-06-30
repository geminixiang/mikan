import { posix } from "path";
import type { ConversationKind, MessagingInfo } from "../adapter.js";
import type { SandboxConfig } from "../sandbox/index.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

export interface BuildSystemPromptOptions {
  workspacePath: string;
  conversationId: string;
  conversationKind: ConversationKind;
  currentUserId?: string;
  memory: string;
  sandboxConfig: SandboxConfig;
  platform: MessagingInfo;
  skills: Skill[];
  isEventTrigger?: boolean;
  triggerAttribution?: string;
}

/**
 * Build the system prompt for mikan agent.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const {
    workspacePath,
    conversationId,
    memory,
    sandboxConfig,
    platform,
    skills,
    isEventTrigger = false,
    triggerAttribution,
  } = options;

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
${eventTriggerInstructions}
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
- event: Schedule immediate, one-shot, or periodic follow-ups
- sandbox: Inspect or temporarily adjust sandbox limits
- attach: Share files to the platform

Each tool requires a "label" parameter (shown to user).
`;
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
