import type { OfficeAddress } from "../adapter.js";
import type { SessionEntry } from "../harness/index.js";

interface DreamSessionCheckpoint {
  throughEntryId: string;
}

export interface DreamState {
  version: 1;
  sessions: Record<string, DreamSessionCheckpoint>;
}

export interface DreamEntryEvidence {
  entryId: string;
  timestamp: number;
  type: SessionEntry["type"];
  serialized: string;
  originalBytes?: number;
}

export interface DreamSessionEvidence {
  sessionId: string;
  entries: DreamEntryEvidence[];
}

export interface DreamPlan {
  evidence: DreamSessionEvidence[];
  latestEvidenceAt: number;
  checkpoint: DreamState;
}

export interface DreamRuntime {
  runDream(address: OfficeAddress, now?: Date): Promise<boolean>;
}
