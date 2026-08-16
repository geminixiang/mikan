import type { SubagentProgressNode } from "../../types.js";
import type { SessionViewItem } from "../session-view/types.js";

export interface WebWorkspace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface WebSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly entryCount: number;
  readonly current: boolean;
}

export interface WebSessionRelation {
  readonly kind: "parent" | "thread";
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly entryCount: number;
  readonly summary?: string;
  readonly anchorEntryId?: string;
}

interface WebSessionItem extends Omit<SessionViewItem, "threads"> {
  readonly threads?: readonly WebSessionRelation[];
}

export interface WebSessionHistory {
  readonly sessionId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly entryCount: number;
  readonly items: readonly WebSessionItem[];
  readonly parent?: WebSessionRelation;
  readonly threads: readonly WebSessionRelation[];
}

export interface WebPromptAccepted {
  readonly accepted: true;
  readonly requestId: string;
  readonly clientRequestId: string;
  readonly placement: "active" | "followUp" | "steering";
}

export interface WebRunSnapshot {
  readonly id: string;
  readonly requestId: string;
  readonly status: "running" | "cancelling" | "failed";
  readonly responseText: string;
}

export interface WebQueueItem {
  readonly requestId: string;
  readonly clientRequestId: string;
  readonly mode: "followUp" | "steer";
  readonly text: string;
}

export interface WebToolSnapshot {
  readonly id: string;
  readonly runId: string;
  readonly name: string;
  readonly label?: string;
  readonly status: "running" | "done" | "error";
  readonly result?: string;
  readonly durationMs?: number;
}

export type WebStreamFrame =
  | {
      readonly type: "stream.ready";
      readonly generation: string;
      readonly workspaceId: string;
    }
  | {
      readonly type: "workspace.snapshot";
      readonly workspace: WebWorkspace;
    }
  | {
      readonly type: "session.snapshot";
      readonly session: WebSessionHistory | null;
    }
  | { readonly type: "run.snapshot"; readonly run: WebRunSnapshot | null }
  | { readonly type: "queue.snapshot"; readonly items: readonly WebQueueItem[] }
  | {
      readonly type: "subagents.snapshot";
      readonly items: readonly SubagentProgressNode[];
    }
  | {
      readonly type: "response.delta";
      readonly runId: string;
      readonly text: string;
    }
  | {
      readonly type: "response.final";
      readonly runId: string;
      readonly text: string;
    }
  | {
      readonly type: "tool.started";
      readonly runId: string;
      readonly tool: WebToolSnapshot;
    }
  | {
      readonly type: "tool.finished";
      readonly runId: string;
      readonly tool: WebToolSnapshot;
    }
  | {
      readonly type: "diagnostic";
      readonly runId?: string;
      readonly level: "info" | "warning" | "error";
      readonly message: string;
    }
  | {
      readonly type: "error";
      readonly requestId?: string;
      readonly runId?: string;
      readonly code: string;
      readonly message: string;
    };
