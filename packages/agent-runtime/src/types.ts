import type { AgentMessageContext, JsonValue } from "@geminixiang/mikan-chat";

export interface AgentRuntimeInput {
  context: AgentMessageContext;
  metadata?: Record<string, JsonValue>;
}

export interface AgentRuntimeResponse {
  conversationId: string;
  text: string;
  events?: AgentRuntimeEvent[];
}

export interface AgentRuntimeEvent {
  type: string;
  timestamp: string;
  payload?: JsonValue;
}

export interface AgentRuntime {
  run(input: AgentRuntimeInput): Promise<AgentRuntimeResponse>;
}

export interface AgentResponse {
  conversationId: string;
  replyToEventId?: string;
  content: string;
  metadata?: Record<string, JsonValue>;
}

export interface AgentRuntimeAdapter {
  run(input: AgentRuntimeInput): Promise<AgentResponse>;
}
