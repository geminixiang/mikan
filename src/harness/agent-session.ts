import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionManager } from "./session-manager.js";

export class AgentSession {
  constructor(
    readonly agent: Agent,
    private readonly sessionManager: SessionManager,
  ) {}

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  subscribe(listener: (event: any, signal: AbortSignal) => Promise<void> | void): () => void {
    return this.agent.subscribe(async (event, signal) => {
      if (event.type === "message_end") this.sessionManager.appendMessage(event.message);
      await listener(event, signal);
    });
  }

  prompt(text: string, images?: ImageContent[] | { images?: ImageContent[] }): Promise<void> {
    return this.agent.prompt(text, Array.isArray(images) ? images : images?.images);
  }

  abort(): void {
    this.agent.abort();
  }

  waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }
}
