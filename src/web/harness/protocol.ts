import type { SessionViewItem } from "../session-view/types.js";

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
