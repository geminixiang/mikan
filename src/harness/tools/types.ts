import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { ConversationMessage, ConversationResponder } from "../../types.js";

interface PlatformToolRunContext {
  conversationId: string;
  platformName: string;
  threadTs?: string;
}

export interface PlatformToolPack {
  tools: AgentTool<TSchema>[];
  finalResponseTools?: readonly string[];
  bindRun(ctx: PlatformToolRunContext): void;
}

export type PlatformToolPackFactory = () => PlatformToolPack;

export interface MikanToolRunContext {
  message: Pick<ConversationMessage, "address" | "conversationKind" | "userId" | "threadTs">;
  responder: ConversationResponder;
  platformName: string;
  runtimeWorkspaceRoot: string;
}

export interface WebFetchAddress {
  address: string;
  family: number;
}

export type WebFetchLookup = (hostname: string) => Promise<WebFetchAddress[]>;

export interface WebFetchResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export type WebFetchRequest = (
  url: string,
  init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> },
) => Promise<WebFetchResponse>;

export interface WebFetchToolOptions {
  fetch?: WebFetchRequest;
  lookup?: WebFetchLookup;
}
