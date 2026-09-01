import type { OfficeAddress } from "../types.js";
import type { MikanAgentSession, MikanSkill } from "../harness/index.js";
import { type Api, type ImageContent, type Model } from "@earendil-works/pi-ai";
import type { ConversationResponder, MessagingInfo, SubagentProgressSnapshot } from "../adapter.js";
import type { PlatformTrustModel } from "../types.js";
import type { resolveConversationSettings } from "../config.js";
import type { ResolvedPackages } from "../packages/types.js";
import { type Executor, type RuntimePathContext, type SandboxConfig } from "../sandbox/index.js";
import type { WorkspaceProjection } from "../workspace-projection/types.js";
import type { Office } from "../office/index.js";

export interface BuildSystemPromptOptions {
  workspacePath: string;
  office: Office;
  memory: string;
  sandboxConfig: SandboxConfig;
  platform: MessagingInfo;
  skills: MikanSkill[];
  projection: WorkspaceProjection;
  skippedSkillLinks?: string[];
}

export interface RunnerSessionState {
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
  subagentProgress: Map<string, SubagentProgressSnapshot>;
  completedSubagentProgress: SubagentProgressSnapshot[];
  subagentToolCalls: Set<string>;
  subagentProgressShown: boolean;
  suppressResponseDeltas: boolean;
  lastSubagentProgressAt: number;
  toolProgressTimer: ReturnType<typeof setTimeout> | undefined;
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

export interface UsageReportContext {
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

export interface RunnerExecutionContext {
  executor: Executor;
  resolveForRun(context: {
    address: OfficeAddress;
    userId: string;
    trustModel?: PlatformTrustModel;
  }): Promise<{
    pathContext: RuntimePathContext;
    projection: WorkspaceProjection;
    packages: ResolvedPackages;
  }>;
}

export interface PreparedRunContext {
  sessionConversation: string;
  runQueue: {
    queue: { enqueue(fn: () => Promise<void>, errorContext: string): void };
    wait: () => Promise<void>;
  };
  userMessage: string;
  imageAttachments: ImageContent[];
  triggerAttribution?: string;
}
