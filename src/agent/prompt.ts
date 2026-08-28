import type { Office } from "../office/index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ImageContent } from "@earendil-works/pi-ai";
import { formatSkillsForPrompt, type MikanSkill } from "../harness/index.js";
import { lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ConversationKind, ConversationMessage, MessagingInfo } from "../adapter.js";
import type { WorkspaceProjection } from "../workspace-projection/types.js";
import * as log from "../log.js";
import { type RuntimePathContext, type SandboxConfig } from "../sandbox/index.js";
import { formatHistoryLine } from "../sessions/history-line.js";
import { buildRuntimePaths, collectMessageAttachments } from "./execution.js";

function formatTimestampedUserMessage(message: ConversationMessage): string {
  return formatHistoryLine({
    date: new Date(),
    userName: message.userName,
    threadTs: message.threadTs,
    text: message.text,
  });
}

export async function buildPromptPayload(
  message: ConversationMessage,
  workspacePath: string,
  pathContext?: RuntimePathContext,
  readAttachment?: (runtimePath: string) => Promise<string>,
): Promise<{
  userMessage: string;
  imageAttachments: ImageContent[];
}> {
  let userMessage = formatTimestampedUserMessage(message);
  const { imageAttachments, nonImagePaths } = await collectMessageAttachments(
    message,
    workspacePath,
    pathContext,
    readAttachment,
  );

  if (nonImagePaths.length > 0) {
    userMessage += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;
  }

  return { userMessage, imageAttachments };
}

export async function getMemory(projection: WorkspaceProjection): Promise<string> {
  const parts: string[] = [];

  const workspaceMemoryPath = projection.promptSources.globalMemoryPath;
  if (workspaceMemoryPath && isRegularFile(workspaceMemoryPath)) {
    try {
      const content = (await readFile(workspaceMemoryPath, "utf-8")).trim();
      if (content) {
        parts.push(`### Global Workspace Memory\n${content}`);
      }
    } catch (error) {
      log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
    }
  }

  const conversationMemoryPath = projection.promptSources.conversationMemoryPath;
  if (isRegularFile(conversationMemoryPath)) {
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

function isRegularFile(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function buildEnvDescription(sandboxType: SandboxConfig["type"], workspaceRoot: string): string {
  switch (sandboxType) {
    case "image":
      return `You are running inside a managed per-conversation container.
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
  office: Office,
  conversationKind: ConversationKind,
  currentUserId: string | undefined,
  memory: string,
  sandboxConfig: SandboxConfig,
  platform: MessagingInfo,
  skills: MikanSkill[],
  projection: WorkspaceProjection,
  skippedSkillLinks: string[] = [],
): string {
  const { workspaceRoot, conversationPath, scratchPath } = buildRuntimePaths(workspacePath, office);
  const sandboxType = sandboxConfig.type;
  const isContainerLike = sandboxType === "container" || sandboxType === "image";

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
  const workspaceLayout =
    projection.layout === "full"
      ? `${workspaceRoot}/ contains the complete trusted workspace.`
      : projection.layout === "shared-support"
        ? `${workspaceRoot}/ contains shared MEMORY.md, skills/, events/, and this conversation's directory.`
        : `${conversationPath}/ is the only conversation workspace mounted; global memory, skills, and events are not available.`;
  const skillStorageGuidance =
    projection.doorPolicy === "trusted"
      ? `Store shared skills in \`${workspaceRoot}/skills/<name>/\` or conversation-specific skills in \`${conversationPath}/skills/<name>/\`.`
      : `Store skills in \`${conversationPath}/skills/<name>/\`; this office cannot access workspace-global skills.`;
  const globalMemoryReadOnly = projection.promptSources.globalMemoryReadOnly === true;
  const memoryGuidance =
    projection.doorPolicy === "trusted"
      ? globalMemoryReadOnly
        ? `\`${workspaceRoot}/MEMORY.md\` is shared workspace memory mounted read-only for this office (private visibility): you can read what other offices have learned, but writes to it are rejected. Write everything you learn here to \`${conversationPath}/MEMORY.md\` instead; it never leaves this conversation.`
        : `Write important shared knowledge to \`${workspaceRoot}/MEMORY.md\` and conversation-specific knowledge to \`${conversationPath}/MEMORY.md\`.`
      : `Write durable knowledge only to \`${conversationPath}/MEMORY.md\`; this office cannot access workspace-global memory.`;
  const systemLogPath =
    projection.layout === "conversation"
      ? `${conversationPath}/SYSTEM.md`
      : `${workspaceRoot}/SYSTEM.md`;
  const slackBlockKitInstructions =
    platform.name === "slack"
      ? `
## Slack Rendering
- The Slack adapter renders responses natively from standard Markdown. Answer in normal Markdown/GFM.
- Markdown pipe tables are rendered as native Slack tables.
- For interactive elements (buttons, select menus), use the slack_blockkit tool; user interactions arrive as "[Slack action] <action_id>: <value>" messages.
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

When mentioning users, write <@userName> using the exact userName from the Users table above (e.g., <@mario>). Never invent handles from other platforms (GitHub, email); the platform adapter converts <@userName> to the platform's native mention form.

## Environment
${envDescription}
- Default place for clones, downloads, and experiments: ${scratchPath}
- Do not use host-only paths unless you are running in host mode and verified they exist.

## Workspace Layout
${workspaceLayout}
${
  projection.layout === "conversation"
    ? `${conversationPath}/           # This conversation`
    : `${workspaceRoot}/
├── MEMORY.md                    # Global memory (all conversations)
├── skills/                      # Global CLI tools you create
└── ${office.key}/           # This conversation`
}
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
${skillStorageGuidance}
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
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}${
    skippedSkillLinks.length > 0
      ? `\n\nNote: these skill entries were skipped because they are symlinks, which the host never follows when reading this conversation's skills: ${skippedSkillLinks.join(", ")}. Replace each with a real file or directory (for example \`cp -rL\`) to load it.`
      : ""
  }

## Events
Use the \`event\` tool to schedule immediate, one-shot, or periodic follow-ups. It writes to the host-side mikan control plane and fills routing fields for the current conversation automatically.

Write event \`text\` as a self-contained future task with needed context, tone, and constraints because events do not inherit normal conversation history.

For one-shot reminders, include a timezone offset in \`at\`. For periodic events, use a cron schedule plus IANA timezone; assume ${Intl.DateTimeFormat().resolvedOptions().timeZone} when users omit timezone.

When events trigger, messages are prefixed like \`[EVENT:filename:type:time]\`. Immediate and one-shot events auto-delete after triggering; periodic events persist until deleted.

For periodic events where there's nothing to report, respond with exactly \`[SILENT]\`. Debounce external triggers; prefer one summarized event over many.

## Memory
${memoryGuidance}
Update it when you learn something important or when asked to remember something.

Memory is a curated note, not a transcript. Before writing an entry, ask whether it is a
stable fact (a decision, a convention, an owner, a recurring constraint) or a one-off event
that belongs in \`log.jsonl\` instead; only write the former. Keep entries short — a long
running log of events crowds out the facts that matter.

Querying, correcting, and forgetting memory are normal, expected requests, not edge cases:
- If asked what you remember, read the memory file(s) above and list the entries plainly.
- If asked to correct or forget something, edit the relevant MEMORY.md to remove or update
  that entry, then confirm what changed.

### Current Memory
${memory}

## System Configuration Log
Maintain ${systemLogPath} to log all environment modifications:
- Installed packages (apt install, npm install, uv pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isMessagingBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
Use \`log.jsonl\` for quick grep-style history. Use \`${conversationPath}/sessions/\` when you need structured turns, tool outputs, or thread/session lineage.
${isContainerLike ? "Install jq: apt-get install jq" : ""}
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

export function sessionDreamPrompt(conversationMemoryPath: string, toolNames: string[]): string {
  // read/edit/write are core tools, so an empty grant does not arise today;
  // the fallback only keeps this sentence coherent if that ever changes.
  const grant =
    toolNames.length === 0
      ? "You have no tools in this run and cannot change memory. Say so and stop."
      : `Your tools this run: ${toolNames.join(", ")}. Nothing else will execute, including tools used earlier in this transcript. ${conversationMemoryPath} is the only path you may write.`;
  return [
    "Before this conversation is reset or rotated, preserve only durable information worth carrying into future sessions of this same conversation.",
    `Review the existing transcript and update only the conversation-specific MEMORY.md at ${conversationMemoryPath}.`,
    grant,
    "Do not modify the workspace-level global MEMORY.md. Information from one DM or channel must not be promoted into memory shared with other conversations by this maintenance run.",
    "Preserve durable decisions, preferences, facts, and ongoing work specific to this conversation. Preserve the concrete values and details needed to resume the work; do not replace them with abstract categories, summaries of retention rules, or statements that merely say a kind of information is durable. An explicit user statement that a fact, preference, or decision should persist is strong evidence that its exact content is worth preserving.",
    "Deduplicate against existing conversation memory. Do not preserve transient discussion, tool noise, secrets, speculative details, or test scaffolding. If there is nothing new worth preserving, make no changes. Do no unrelated work.",
  ].join("\n");
}

export const SESSION_DREAM_BUDGET = {
  maxDurationMs: 2 * 60 * 1000,
  maxLlmCalls: 10,
};

export function sessionDreamTools(tools: AgentTool[], conversationMemoryPath: string): AgentTool[] {
  return tools
    .filter((tool) => tool.name === "read" || tool.name === "edit" || tool.name === "write")
    .map((tool) => {
      if (tool.name === "read") return tool;
      return Object.assign({}, tool, {
        execute: async (...args: Parameters<AgentTool["execute"]>) => {
          const params = args[1] as { path?: unknown };
          if (params.path !== conversationMemoryPath) {
            throw new Error(`Session Dream may only modify ${conversationMemoryPath}`);
          }
          return tool.execute(...args);
        },
      });
    });
}
