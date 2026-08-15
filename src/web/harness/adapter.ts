import type { HarnessEvent } from "@geminixiang/mikan-harness-web-contract";
import type {
  ChatToolResult,
  ConversationEvent,
  ConversationResponder,
  MessagingBot,
  MessagingInfo,
} from "../../adapter.js";

interface WebResponseScope {
  officeKey: string;
  sessionId: string;
  runId: string;
}

type PublishHarnessEvent = (event: HarnessEvent) => void;

/** Response adapter from the shared ConversationRuntime into browser events. */
export class WebConversationResponder implements ConversationResponder {
  private responseText = "";
  private lastDiagnostic = "";

  constructor(
    private readonly scope: WebResponseScope,
    private readonly publish: PublishHarnessEvent,
  ) {}

  async respond(text: string): Promise<void> {
    this.diagnostic(text, "muted");
  }

  async appendResponseDelta(delta: string): Promise<void> {
    this.lastDiagnostic = "";
    this.responseText += delta;
    this.publish({ kind: "response.delta", ...this.scope, delta });
  }

  async finishResponse(finalText?: string): Promise<void> {
    if (finalText !== undefined) this.responseText = finalText;
    this.publish({ kind: "response.finished", ...this.scope, text: this.responseText });
  }

  async replaceResponse(text: string): Promise<void> {
    this.lastDiagnostic = "";
    this.responseText = text;
    this.publish({ kind: "response.replaced", ...this.scope, text });
  }

  async respondDiagnostic(text: string, options?: { style?: "muted" | "error" }): Promise<void> {
    this.diagnostic(text, options?.style ?? "muted");
  }

  async respondToolResult(result: ChatToolResult): Promise<void> {
    this.lastDiagnostic = "";
    this.publish({
      kind: "tool.result",
      ...this.scope,
      title: result.label || result.toolName,
      text: result.result,
      tone: result.isError ? "error" : "ok",
    });
  }

  async setTyping(_isTyping: boolean): Promise<void> {}

  async setWorking(_working: boolean): Promise<void> {}

  async uploadFile(filePath: string, title?: string): Promise<void> {
    this.diagnostic(`File ready: ${title || filePath}`, "muted");
  }

  async deleteResponse(): Promise<void> {
    this.responseText = "";
    this.publish({ kind: "response.replaced", ...this.scope, text: "" });
  }

  private diagnostic(text: string, tone: "muted" | "error"): void {
    if (!text || text === this.lastDiagnostic) return;
    this.lastDiagnostic = text;
    this.publish({ kind: "diagnostic", ...this.scope, text, tone });
  }
}

/** Minimal synthetic platform adapter used only to re-enter ConversationRuntime. */
export class WebMessagingBot implements MessagingBot {
  constructor(
    private readonly responder: ConversationResponder,
    private readonly info: MessagingInfo,
  ) {}

  async start(): Promise<void> {}

  async postMessage(_channel: string, text: string): Promise<string> {
    await this.responder.respondDiagnostic(text, { style: "muted" });
    return `web-${Date.now()}`;
  }

  async updateMessage(_channel: string, _ts: string, text: string): Promise<void> {
    await this.responder.respondDiagnostic(text, { style: "muted" });
  }

  enqueueEvent(_event: ConversationEvent): boolean {
    return false;
  }

  getMessagingInfo(): MessagingInfo {
    return this.info;
  }
}

export function webMessagingInfo(principalId: string, displayName: string): MessagingInfo {
  return {
    name: "web",
    formattingGuide: "Use Markdown for formatting.",
    channels: [],
    users: [{ id: principalId, userName: displayName, displayName }],
    trustModel: "membership",
  };
}
