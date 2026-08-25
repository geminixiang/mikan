import type {
  HarnessBootstrap,
  HarnessCommand,
  HarnessCommandResult,
  HarnessConversationSnapshot,
  HarnessCursor,
  HarnessEventEnvelope,
  HarnessModelOption,
  HarnessPrincipal,
  HarnessThinkingLevel,
} from "@geminixiang/mikan-harness-web-contract";

export type HarnessClientStatus = "loading" | "ready" | "unauthenticated" | "error";
export type HarnessConnectionStatus = "connecting" | "connected" | "reconnecting";

export interface HarnessClientSnapshot {
  status: HarnessClientStatus;
  connection: HarnessConnectionStatus;
  error?: string;
  principal?: HarnessPrincipal;
  conversations: HarnessBootstrap["conversations"];
  conversation?: HarnessConversationSnapshot;
  models: HarnessModelOption[];
}

export interface HarnessHostPort {
  bootstrap(officeKey?: string): Promise<HarnessBootstrap>;
  execute(command: HarnessCommand): Promise<HarnessCommandResult>;
  subscribe(
    cursor: HarnessCursor,
    onEvent: (event: HarnessEventEnvelope) => void,
    onReset: () => void,
    onConnection: (status: HarnessConnectionStatus) => void,
  ): () => void;
  logout(): Promise<void>;
}

export interface HarnessClientActions {
  open(officeKey?: string): Promise<void>;
  createConversation(): Promise<string>;
  prompt(text: string): Promise<void>;
  cancel(): Promise<void>;
  setModel(provider: string, model: string, thinkingLevel: HarnessThinkingLevel): Promise<void>;
  logout(): Promise<void>;
}
