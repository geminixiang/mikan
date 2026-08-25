export type HarnessThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface HarnessCursor {
  epoch: string;
  sequence: number;
}

export interface HarnessPrincipal {
  id: string;
  displayName: string;
}

export interface HarnessModelOption {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
}

export interface HarnessModelSelection {
  provider: string;
  model: string;
  thinkingLevel: HarnessThinkingLevel;
}

export interface HarnessRunSnapshot {
  id: string;
  startedAt: string;
  status: "running" | "stopping";
}

export interface HarnessConversationSummary {
  officeKey: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  model: HarnessModelSelection;
  run?: HarnessRunSnapshot;
}

export interface HarnessTranscriptItem {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  title: string;
  text: string;
  timestamp: string;
  tone?: "default" | "ok" | "error" | "muted";
}

export interface HarnessConversationSnapshot extends HarnessConversationSummary {
  transcript: HarnessTranscriptItem[];
}

export interface HarnessBootstrap {
  principal: HarnessPrincipal;
  conversations: HarnessConversationSummary[];
  conversation?: HarnessConversationSnapshot;
  models: HarnessModelOption[];
  cursor: HarnessCursor;
}

interface HarnessCommandBase {
  commandId: string;
}

export interface CreateConversationCommand extends HarnessCommandBase {
  kind: "create-conversation";
}

export interface PromptCommand extends HarnessCommandBase {
  kind: "prompt";
  officeKey: string;
  sessionId: string;
  text: string;
}

export interface CancelRunCommand extends HarnessCommandBase {
  kind: "cancel-run";
  officeKey: string;
  sessionId: string;
  runId: string;
}

export interface SetModelCommand extends HarnessCommandBase {
  kind: "set-model";
  officeKey: string;
  sessionId: string;
  provider: string;
  model: string;
  thinkingLevel: HarnessThinkingLevel;
}

export type HarnessCommand =
  | CreateConversationCommand
  | PromptCommand
  | CancelRunCommand
  | SetModelCommand;

export type HarnessCommandResult =
  | { kind: "conversation-created"; conversation: HarnessConversationSnapshot }
  | { kind: "prompt-accepted"; runId: string }
  | { kind: "run-cancelled"; runId: string }
  | { kind: "model-updated"; conversation: HarnessConversationSummary };

export type HarnessEvent =
  | { kind: "conversation.created"; conversation: HarnessConversationSummary }
  | { kind: "conversation.updated"; conversation: HarnessConversationSummary }
  | {
      kind: "run.started";
      officeKey: string;
      sessionId: string;
      run: HarnessRunSnapshot;
      userItem: HarnessTranscriptItem;
    }
  | {
      kind: "run.stopping";
      officeKey: string;
      sessionId: string;
      runId: string;
    }
  | {
      kind: "response.delta";
      officeKey: string;
      sessionId: string;
      runId: string;
      delta: string;
    }
  | {
      kind: "response.replaced";
      officeKey: string;
      sessionId: string;
      runId: string;
      text: string;
    }
  | {
      kind: "response.finished";
      officeKey: string;
      sessionId: string;
      runId: string;
      text: string;
    }
  | {
      kind: "diagnostic";
      officeKey: string;
      sessionId: string;
      runId: string;
      text: string;
      tone: "muted" | "error";
    }
  | {
      kind: "tool.result";
      officeKey: string;
      sessionId: string;
      runId: string;
      title: string;
      text: string;
      tone: "ok" | "error";
    }
  | {
      kind: "run.finished";
      officeKey: string;
      sessionId: string;
      runId: string;
      outcome: "completed" | "cancelled" | "failed";
    }
  | {
      kind: "model.updated";
      officeKey: string;
      sessionId: string;
      model: HarnessModelSelection;
    };

export interface HarnessEventEnvelope {
  cursor: HarnessCursor;
  event: HarnessEvent;
}

export type HarnessStreamMessage =
  | { kind: "event"; envelope: HarnessEventEnvelope }
  | { kind: "reset"; cursor: HarnessCursor };

export type HarnessErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "invalid"
  | "conflict"
  | "unavailable";

export interface HarnessErrorBody {
  error: {
    code: HarnessErrorCode;
    message: string;
  };
}
