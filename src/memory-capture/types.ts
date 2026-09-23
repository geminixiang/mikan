import type { Office } from "../office/index.js";
import type { ConversationMessage } from "../types.js";

export interface CapturedRun {
  office: Office;
  message: ConversationMessage;
  stopReason: string;
  reply: string;
}

export interface RunMemoryCapture {
  capture(run: CapturedRun): void;
}

export type MemoryCaptureOp =
  | { op: "add"; text: string }
  | { op: "update"; replaces: string; text: string };

export interface MemoryCaptureDeps {
  gate(run: CapturedRun): Promise<number>;
  extract(run: CapturedRun, memory: string): Promise<MemoryCaptureOp[]>;
  now(): Date;
}

export interface AppliedMemoryOps {
  content: string;
  added: number;
  updated: number;
}
