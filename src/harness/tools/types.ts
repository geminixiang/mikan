import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

export interface PlatformToolRunContext {
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
