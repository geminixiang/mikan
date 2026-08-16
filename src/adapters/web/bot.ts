import { randomUUID } from "node:crypto";
import type {
  ConversationContext,
  ConversationEvent,
  MessagingBot,
  MessagingInfo,
  PlatformHistoryMessage,
} from "../../adapter.js";
import { createConversationMessage } from "../../adapter.js";
import { appendBotResponseLog, appendChannelLog } from "../shared.js";
import type { Workspace } from "../../office/index.js";
import { createOfficeAddress } from "../../office/index.js";
import type { WebAccount } from "../../web/auth/types.js";
import type { WebEventHub } from "../../web/harness/hub.js";
import { readConversationLog } from "../../sessions/conversation-log.js";
import { createWebResponder, markWebResponderFailed } from "./responder.js";

export interface WebRunRequest {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly account: WebAccount;
  readonly text: string;
}

/** First-class Web adapter over the shared messaging/runtime contracts. */
export class WebMessagingBot implements MessagingBot {
  private readonly info: MessagingInfo = {
    name: "web",
    formattingGuide: "Use standard Markdown.",
    channels: [],
    users: [],
    trustModel: "membership",
    bareExtensionCommands: true,
    diagnostics: { showUsageSummary: false },
  };

  constructor(
    private readonly workspace: Workspace,
    private readonly hub: WebEventHub,
  ) {}

  async start(): Promise<void> {}

  getMessagingInfo(): MessagingInfo {
    return this.info;
  }

  async postMessage(workspaceId: string, text: string): Promise<string> {
    const id = randomUUID();
    appendBotResponseLog(this.office(workspaceId), text, id);
    this.hub.publish(workspaceId, {
      type: "diagnostic",
      level: "info",
      message: text,
    });
    return id;
  }

  async updateMessage(workspaceId: string, _messageId: string, text: string): Promise<void> {
    this.hub.publish(workspaceId, {
      type: "diagnostic",
      level: "info",
      message: text,
    });
  }

  enqueueEvent(_event: ConversationEvent): boolean {
    return false;
  }

  async fetchHistory(
    workspaceId: string,
    options: { oldest?: string; limit?: number } = {},
  ): Promise<PlatformHistoryMessage[]> {
    const records: PlatformHistoryMessage[] = [];
    for (const { message } of readConversationLog(this.office(workspaceId).dir)) {
      if (!message.ts || (options.oldest && message.ts <= options.oldest)) continue;
      records.push({
        ts: message.ts,
        ...(message.user ? { userId: message.user } : {}),
        ...(message.userName ? { userName: message.userName } : {}),
        text: message.text ?? "",
        isBot: message.isMessagingBot === true,
      });
    }
    return records.slice(-(options.limit ?? records.length));
  }

  createContext(request: WebRunRequest, event: ConversationEvent): ConversationContext {
    const { requestId, workspaceId, account, text } = request;
    return {
      address: event.address,
      message: createConversationMessage({
        platform: "web",
        conversationId: workspaceId,
        address: event.address,
        id: requestId,
        sessionKey: workspaceId,
        conversationKind: "direct",
        userId: account.id,
        userName: account.displayName,
        text,
        attachments: [],
      }),
      responder: createWebResponder({
        hub: this.hub,
        workspaceId,
        runId: requestId,
        requestId,
      }),
      platform: this.info,
    };
  }

  recordUserMessage(request: WebRunRequest): void {
    appendChannelLog(this.office(request.workspaceId), {
      date: new Date().toISOString(),
      ts: request.requestId,
      user: request.account.id,
      userName: request.account.displayName,
      text: request.text,
      attachments: [],
      isMessagingBot: false,
    });
  }

  reportRunFailure(request: WebRunRequest, error: unknown): void {
    markWebResponderFailed(
      this.hub,
      request.workspaceId,
      request.requestId,
      request.requestId,
      error instanceof Error ? error.message : "Web run failed",
    );
  }

  private office(workspaceId: string) {
    return this.workspace.office(createOfficeAddress("web", workspaceId));
  }
}
