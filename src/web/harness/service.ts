import { randomUUID } from "node:crypto";
import { createConversationEvent } from "../../adapter.js";
import type { WebMessagingBot } from "../../adapters/web/bot.js";
import type { HarnessEvent } from "../../harness/index.js";
import type { Office, Workspace } from "../../office/index.js";
import { createOfficeAddress } from "../../office/index.js";
import type { ConversationRuntime } from "../../runtime/conversation-runtime.js";
import { listDurableSessions, resolveDurableSessionTarget } from "../../sessions/store.js";
import type { WebAuthRegistry } from "../auth/registry.js";
import type { WebAccount, WebWorkspaceRecord } from "../auth/types.js";
import { loadSessionViewModel } from "../session-view/service.js";
import type { WebEventHub } from "./hub.js";
import type {
  WebPromptAccepted,
  WebQueueItem,
  WebSessionHistory,
  WebSessionRelation,
  WebSessionSummary,
  WebWorkspace,
} from "./protocol.js";

export type { WebSessionHistory, WebSessionSummary } from "./protocol.js";

const REQUEST_RETENTION_MS = 10 * 60_000;
const MAX_REQUESTS_PER_WORKSPACE = 256;

interface WebRequestRecord extends WebPromptAccepted {
  readonly text: string;
  readonly mode: "prompt" | "followUp" | "steer";
  readonly createdAt: number;
}

export interface WebHarnessServiceOptions {
  readonly runtime?: ConversationRuntime;
  readonly bot?: WebMessagingBot;
  readonly hub?: WebEventHub;
  readonly now?: () => number;
}

/** Authorized domain operations for Web workspaces and their durable sessions. */
export class WebHarnessService {
  private readonly queued = new Map<string, Map<string, WebQueueItem>>();
  private readonly runtimeSubscriptions = new Map<string, () => void>();
  private readonly requests = new Map<string, Map<string, WebRequestRecord>>();
  private readonly pendingPrompts = new Set<string>();
  private readonly runtime: ConversationRuntime | undefined;
  private readonly bot: WebMessagingBot | undefined;
  private readonly hub: WebEventHub | undefined;
  private readonly now: () => number;

  constructor(
    private readonly registry: WebAuthRegistry,
    private readonly workspace: Workspace,
    options: WebHarnessServiceOptions = {},
  ) {
    this.runtime = options.runtime;
    this.bot = options.bot;
    this.hub = options.hub;
    this.now = options.now ?? Date.now;
  }

  listWorkspaces(account: WebAccount): readonly WebWorkspace[] {
    return this.registry.listWorkspaces(account.id).map(publicWorkspace);
  }

  createWorkspace(account: WebAccount, name: string): WebWorkspace {
    const record = this.registry.createWorkspace(account.id, name);
    this.office(record).ensure();
    return publicWorkspace(record);
  }

  renameWorkspace(account: WebAccount, workspaceId: string, name: string): WebWorkspace | null {
    const record = this.registry.renameWorkspace(account.id, workspaceId, name);
    return record ? publicWorkspace(record) : null;
  }

  getOwnedWorkspace(account: WebAccount, workspaceId: string): WebWorkspaceRecord | null {
    return this.registry.getOwnedWorkspace(account.id, workspaceId);
  }

  submitPrompt(
    account: WebAccount,
    workspaceId: string,
    input: {
      text: string;
      clientRequestId: string;
      mode: "prompt" | "followUp" | "steer";
    },
  ):
    | { status: "not-found" }
    | { status: "unavailable" }
    | { status: "busy" }
    | ({ status: "accepted" } & WebPromptAccepted) {
    const owned = this.getOwnedWorkspace(account, workspaceId);
    if (!owned) return { status: "not-found" };
    if (!this.runtime || !this.bot || !this.hub) return { status: "unavailable" };

    const existing = this.findRequest(owned.id, input.clientRequestId);
    if (existing) {
      if (existing.text !== input.text || existing.mode !== input.mode) return { status: "busy" };
      return { status: "accepted", ...publicAccepted(existing) };
    }

    const address = createOfficeAddress("web", owned.id);
    if (
      input.mode === "prompt" &&
      (this.pendingPrompts.has(owned.id) || this.runtime.isRunning(address, owned.id))
    ) {
      return { status: "busy" };
    }

    const requestId = randomUUID();
    if (input.mode !== "prompt") {
      return this.submitQueuedPrompt(owned, account, { ...input, mode: input.mode }, requestId);
    }

    const { event, request, context } = this.createRunContext(
      owned,
      account,
      input.text,
      requestId,
    );
    this.pendingPrompts.add(owned.id);
    this.bot.recordUserMessage(request);
    this.hub.publish(owned.id, {
      type: "run.snapshot",
      run: { id: requestId, requestId, status: "running", responseText: "" },
    });
    const accepted = this.rememberRequest(owned.id, {
      accepted: true,
      requestId,
      clientRequestId: input.clientRequestId,
      placement: "active",
      text: input.text,
      mode: input.mode,
      createdAt: this.now(),
    });
    void this.runtime
      .handleEvent(event, this.bot, context)
      .catch((error) => {
        this.bot?.reportRunFailure(request, error);
      })
      .finally(() => {
        this.pendingPrompts.delete(owned.id);
        this.disposeRuntimeSubscription(owned.id);
      });
    return { status: "accepted", ...publicAccepted(accepted) };
  }

  cancel(
    account: WebAccount,
    workspaceId: string,
  ): "not-found" | "unavailable" | "stopping" | "idle" {
    const owned = this.getOwnedWorkspace(account, workspaceId);
    if (!owned) return "not-found";
    if (!this.runtime || !this.hub) return "unavailable";
    const address = createOfficeAddress("web", owned.id);
    if (!this.runtime.isRunning(address, owned.id)) return "idle";
    const current = this.hub.snapshot(owned.id).run;
    if (current) {
      this.hub.publish(owned.id, {
        type: "run.snapshot",
        run: { ...current, status: "cancelling" },
      });
    }
    this.runtime.forceStop(address, owned.id);
    return "stopping";
  }

  streamSnapshot(
    account: WebAccount,
    workspaceId: string,
  ):
    | { status: "not-found" }
    | {
        status: "available";
        workspace: WebWorkspace;
        generation: string;
        transient: ReturnType<WebEventHub["snapshot"]>;
      } {
    const owned = this.getOwnedWorkspace(account, workspaceId);
    if (!owned) return { status: "not-found" };
    if (!this.hub) return { status: "not-found" };
    return {
      status: "available",
      workspace: publicWorkspace(owned),
      generation: this.hub.generation,
      transient: this.hub.snapshot(owned.id),
    };
  }

  subscribe(
    account: WebAccount,
    workspaceId: string,
    send: Parameters<WebEventHub["subscribe"]>[1],
  ): ReturnType<WebEventHub["subscribe"]> | null {
    const owned = this.getOwnedWorkspace(account, workspaceId);
    if (!owned || !this.hub) return null;
    return this.hub.subscribe(owned.id, send);
  }

  async loadCurrentHistory(
    account: WebAccount,
    workspaceId: string,
  ): Promise<WebSessionHistory | null> {
    return this.loadHistory(account, workspaceId);
  }

  async listSessions(
    account: WebAccount,
    workspaceId: string,
  ): Promise<readonly WebSessionSummary[] | null> {
    const owned = this.getOwnedWorkspace(account, workspaceId);
    if (!owned) return null;
    const office = this.office(owned);
    return Promise.all(
      listDurableSessions(office.sessionsDir, office.address).map(async (session) => {
        const view = await loadSessionViewModel(session.file);
        return {
          id: session.id,
          title: view.title,
          createdAt: view.createdAt,
          updatedAt: view.updatedAt,
          entryCount: view.entryCount,
          current: session.current,
        };
      }),
    ).then((sessions) =>
      sessions.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    );
  }

  async loadHistory(
    account: WebAccount,
    workspaceId: string,
    sessionId?: string,
  ): Promise<WebSessionHistory | null> {
    const owned = this.getOwnedWorkspace(account, workspaceId);
    if (!owned) return null;
    const office = this.office(owned);
    const target = sessionId
      ? resolveDurableSessionTarget(office.sessionsDir, office.address, sessionId)
      : listDurableSessions(office.sessionsDir, office.address).find((session) => session.current);
    if (!target) return null;
    const view = await loadSessionViewModel(target.file);
    return {
      sessionId: view.sessionId,
      title: view.title,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      entryCount: view.entryCount,
      items: view.items.map((item) => ({
        ...item,
        ...(item.threads ? { threads: item.threads.map(publicRelation) } : {}),
      })),
      ...(view.parent ? { parent: publicRelation(view.parent) } : {}),
      threads: view.threads.map(publicRelation),
    };
  }

  private submitQueuedPrompt(
    workspace: WebWorkspaceRecord,
    account: WebAccount,
    input: {
      text: string;
      clientRequestId: string;
      mode: "followUp" | "steer";
    },
    requestId: string,
  ): ({ status: "accepted" } & WebPromptAccepted) | { status: "busy" } {
    const address = createOfficeAddress("web", workspace.id);
    const { request, context } = this.createRunContext(workspace, account, input.text, requestId);
    const queued = this.runtime?.queueMessage(
      address,
      workspace.id,
      context.message,
      input.mode,
      requestId,
    );
    if (!queued || !this.bot) return { status: "busy" };

    this.bot.recordUserMessage(request);
    const queue = this.queued.get(workspace.id) ?? new Map<string, WebQueueItem>();
    queue.set(requestId, {
      requestId,
      clientRequestId: input.clientRequestId,
      mode: input.mode,
      text: input.text,
    });
    this.queued.set(workspace.id, queue);
    this.ensureRuntimeSubscription(workspace.id, address);
    const accepted = this.rememberRequest(workspace.id, {
      accepted: true,
      requestId,
      clientRequestId: input.clientRequestId,
      placement: input.mode === "steer" ? "steering" : "followUp",
      text: input.text,
      mode: input.mode,
      createdAt: this.now(),
    });
    this.publishQueue(workspace.id);
    return { status: "accepted", ...publicAccepted(accepted) };
  }

  private createRunContext(
    workspace: WebWorkspaceRecord,
    account: WebAccount,
    text: string,
    requestId: string,
  ) {
    if (!this.bot) throw new Error("Web runtime unavailable");
    const event = createConversationEvent({
      platform: "web",
      type: "web_prompt",
      conversationId: workspace.id,
      conversationKind: "direct",
      ts: requestId,
      user: account.id,
      text,
      attachments: [],
      sessionKey: workspace.id,
    });
    const request = {
      requestId,
      workspaceId: workspace.id,
      account,
      text,
    };
    return { event, request, context: this.bot.createContext(request, event) };
  }

  private ensureRuntimeSubscription(
    workspaceId: string,
    address: ReturnType<typeof createOfficeAddress>,
  ): void {
    if (this.runtimeSubscriptions.has(workspaceId) || !this.runtime) return;
    const unsubscribe = this.runtime.subscribe(address, workspaceId, (event) => {
      this.handleRuntimeEvent(workspaceId, event);
    });
    if (unsubscribe) this.runtimeSubscriptions.set(workspaceId, unsubscribe);
  }

  private handleRuntimeEvent(workspaceId: string, event: HarnessEvent): void {
    if (event.type === "queued_message_start") {
      const queue = this.queued.get(workspaceId);
      if (queue?.delete(event.queueId)) {
        if (queue.size === 0) this.queued.delete(workspaceId);
        this.publishQueue(workspaceId);
      }
      return;
    }
    if (event.type === "agent_end" && this.queued.get(workspaceId)?.size) {
      this.queued.delete(workspaceId);
      this.publishQueue(workspaceId);
    }
  }

  private publishQueue(workspaceId: string): void {
    this.hub?.publish(workspaceId, {
      type: "queue.snapshot",
      items: Array.from(this.queued.get(workspaceId)?.values() ?? []),
    });
  }

  private findRequest(workspaceId: string, clientRequestId: string): WebRequestRecord | undefined {
    this.pruneRequests(workspaceId);
    return this.requests.get(workspaceId)?.get(clientRequestId);
  }

  private rememberRequest(workspaceId: string, request: WebRequestRecord): WebRequestRecord {
    this.pruneRequests(workspaceId);
    const requests = this.requests.get(workspaceId) ?? new Map<string, WebRequestRecord>();
    requests.set(request.clientRequestId, request);
    while (requests.size > MAX_REQUESTS_PER_WORKSPACE) {
      const oldest = requests.keys().next().value as string | undefined;
      if (!oldest) break;
      requests.delete(oldest);
    }
    this.requests.set(workspaceId, requests);
    return request;
  }

  private pruneRequests(workspaceId: string): void {
    const requests = this.requests.get(workspaceId);
    if (!requests) return;
    const cutoff = this.now() - REQUEST_RETENTION_MS;
    for (const [id, request] of requests) {
      if (request.createdAt < cutoff) requests.delete(id);
    }
    if (requests.size === 0) this.requests.delete(workspaceId);
  }

  private disposeRuntimeSubscription(workspaceId: string): void {
    this.runtimeSubscriptions.get(workspaceId)?.();
    this.runtimeSubscriptions.delete(workspaceId);
    if (this.queued.get(workspaceId)?.size) {
      this.queued.delete(workspaceId);
      this.publishQueue(workspaceId);
    }
  }

  private office(record: WebWorkspaceRecord): Office {
    return this.workspace.office(createOfficeAddress("web", record.id));
  }
}

function publicAccepted(request: WebRequestRecord): WebPromptAccepted {
  return {
    accepted: true,
    requestId: request.requestId,
    clientRequestId: request.clientRequestId,
    placement: request.placement,
  };
}

function publicWorkspace(record: WebWorkspaceRecord): WebWorkspace {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function publicRelation(relation: {
  kind: "parent" | "thread";
  sessionId: string;
  title: string;
  updatedAt: string;
  entryCount: number;
  summary?: string;
  anchorEntryId?: string;
}): WebSessionRelation {
  return {
    kind: relation.kind,
    sessionId: relation.sessionId,
    title: relation.title,
    updatedAt: relation.updatedAt,
    entryCount: relation.entryCount,
    ...(relation.summary !== undefined ? { summary: relation.summary } : {}),
    ...(relation.anchorEntryId !== undefined ? { anchorEntryId: relation.anchorEntryId } : {}),
  };
}
