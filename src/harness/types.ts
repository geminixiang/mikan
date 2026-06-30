import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface AuthStatus {
  configured: boolean;
  source?: string;
}

export type ResolvedRequestAuth =
  | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
  | { ok: false; error: string };

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation?: boolean;
  source?: string;
}

export interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: Array<{ type: "warning"; message: string; path: string }>;
}

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

type ThinkingLevelChangeEntry = SessionEntryBase & {
  type: "thinking_level_change";
  thinkingLevel: string;
};

type ModelChangeEntry = SessionEntryBase & {
  type: "model_change";
  provider: string;
  modelId: string;
};

type CustomMessageEntry = SessionEntryBase & {
  type: "custom_message";
  customType: string;
  content: unknown;
  display: boolean;
  details?: unknown;
};

export type BranchSummaryEntry = SessionEntryBase & {
  type: "branch_summary";
  summary: string;
  fromId: string;
};

export type CompactionEntry = SessionEntryBase & {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
};

type LabelEntry = SessionEntryBase & {
  type: "label";
  targetId: string;
  label?: string;
};

type CustomEntry = SessionEntryBase & {
  type: "custom";
  customType: string;
  data?: unknown;
};

type SessionNameEntry = SessionEntryBase & {
  type: "session_name";
  name: string;
};

type SessionInfoEntry = SessionEntryBase & {
  type: "session_info";
  name?: string;
};

export type SessionEntry =
  | SessionHeader
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CustomMessageEntry
  | BranchSummaryEntry
  | CompactionEntry
  | LabelEntry
  | CustomEntry
  | SessionNameEntry
  | SessionInfoEntry;

export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}
