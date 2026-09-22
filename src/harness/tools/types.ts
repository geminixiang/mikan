import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";

export interface PlatformToolRunContext {
  conversationId: string;
  platformName: string;
  threadTs?: string;
}

export interface PlatformToolPack {
  tools: AgentTool<TSchema>[];
  bindRun(ctx: PlatformToolRunContext): void;
}

export type PlatformToolPackFactory = () => PlatformToolPack;
