import type { BlockList } from "node:net";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import type { ConversationMessage, ConversationResponder } from "../../types.js";

interface PlatformToolRunContext {
  conversationId: string;
  platformName: string;
  threadTs?: string;
}

export interface PlatformToolPack {
  tools: ToolRegistration<TSchema>[];
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

export interface WebFetchToolOptions {
  blocked?: BlockList;
}

export interface DesktopAccess {
  link(platformUserId: string): string;
  open(platformUserId: string): Promise<boolean>;
}
