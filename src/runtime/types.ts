import type { McpServerConfig, RunEventPublisher } from "../harness/types.js";
import type { EventScheduleSink } from "../events/index.js";
import type { BackgroundJobSink } from "../events/jobs.js";
import type { CreateRunnerOptions, PiAgentWrapper, PlatformTrustModel } from "../types.js";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  GlobalRunnerCacheControl,
  MessagingEventHandler,
  OfficeAddress,
  RunnerCacheControl,
} from "../types.js";
import type { CommandServices } from "../adapters/commands/types.js";
import type { MikanModels } from "../harness/models.js";
import type { PlatformToolPackFactory } from "../harness/tools/types.js";

export type RunnerFactory = (options: CreateRunnerOptions) => Promise<PiAgentWrapper>;

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
  detachOnShutdown?: boolean;
  stopNoticeOwned?: boolean;
  lastAccessedAt: number;
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
  connectorScope?: string;
}

export interface ConversationRuntimeOptions extends Omit<CommandServices, "runtime"> {
  models: MikanModels;
  openConnector?: McpServerConfig;
  eventScheduler?: () => EventScheduleSink | undefined;
  backgroundJobs?: BackgroundJobSink;
  platformToolPackFactories?: readonly PlatformToolPackFactory[];
  runnerFactory?: RunnerFactory;
  runEvents?: RunEventPublisher;
}

export interface ConversationRuntime
  extends MessagingEventHandler, RunnerCacheControl, GlobalRunnerCacheControl {
  runSession(options: RunSessionOptions): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}
