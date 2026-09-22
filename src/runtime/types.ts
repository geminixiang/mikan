import type { McpServerConfig } from "../harness/types.js";
import type { EventScheduleSink } from "../events/index.js";
import type { PiAgentWrapper, PlatformTrustModel } from "../types.js";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
  OfficeAddress,
} from "../types.js";
import type {
  AdminTokenStoreLike,
  CommandHandler,
  CommandServices,
  LinkTokenStoreLike,
  SessionViewTokenStoreLike,
} from "../adapters/commands/types.js";
import type { MikanModels } from "../harness/index.js";
import type { PlatformToolPackFactory } from "../harness/tools/types.js";
import type { VaultManager } from "../vault/index.js";

export interface SessionLifecycleOptions {
  maxSessions?: number;
  idleTimeoutMs?: number;
  now?: () => number;
}

export interface ConversationRuntimeState {
  address: OfficeAddress;
  sessionKey: string;
  running: boolean;
  runSettlement?: Promise<void>;
  runner: PiAgentWrapper;
  stopRequested: boolean;
  shutdownAborted?: boolean;
  stopNoticeOwned?: boolean;
  lastAccessedAt: number;
  sessionFile: string;
  startedAt: number;
  lastActivityAt?: number;
}

export interface RunSessionOptions {
  event: ConversationEvent;
  bot: MessagingBot;
  context: ConversationContext;
}

export interface SessionStateOptions {
  address: OfficeAddress;
  sessionKey: string;
  trustModel: PlatformTrustModel;
  platformWorkspaceId?: string;
}

export interface ConversationRuntimeOptions extends Omit<
  CommandServices,
  "runtime" | "vaultManager" | "linkTokenStore" | "sessionViewTokenStore" | "adminTokenStore"
> {
  vaultManager?: VaultManager;
  linkTokenStore?: LinkTokenStoreLike;
  sessionViewTokenStore?: SessionViewTokenStoreLike;
  adminTokenStore?: AdminTokenStoreLike;
  commandHandlers?: readonly CommandHandler[];
  models?: MikanModels;
  openConnector?: McpServerConfig;
  eventScheduler?: () => EventScheduleSink | undefined;
  platformToolPackFactories?: readonly PlatformToolPackFactory[];
}

export interface ConversationRuntime extends MessagingEventHandler {
  runSession(options: RunSessionOptions): Promise<void>;
  runDream(address: OfficeAddress, now?: Date): Promise<boolean>;
  switchConversationModel(address: OfficeAddress, provider: string, model: string): boolean;
  refreshConversationEnvironment(address: OfficeAddress): boolean;
  refreshAllConversations(): { busy: OfficeAddress[] };
  shutdown(timeoutMs?: number): Promise<void>;
}
