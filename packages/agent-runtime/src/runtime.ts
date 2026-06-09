import type { AgentRuntimeAdapter, AgentRuntimeInput, AgentRuntimeResponse } from "./types.js";

export class PlatformNeutralAgentRuntime {
  constructor(private readonly adapter: AgentRuntimeAdapter) {}

  async run(input: AgentRuntimeInput): Promise<AgentRuntimeResponse> {
    const response = await this.adapter.run(input);
    return {
      conversationId: response.conversationId,
      text: response.content,
      events: [
        {
          type: "agent.response.generated",
          timestamp: new Date().toISOString(),
          payload: {
            replyToEventId: response.replyToEventId ?? null,
            content: response.content,
            metadata: response.metadata ?? {},
          },
        },
      ],
    };
  }
}

export function createAgentRuntime(adapter: AgentRuntimeAdapter): PlatformNeutralAgentRuntime {
  return new PlatformNeutralAgentRuntime(adapter);
}
