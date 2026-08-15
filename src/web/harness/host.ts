import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  HarnessBootstrap,
  HarnessCommand,
  HarnessCommandResult,
  HarnessConversationSnapshot,
  HarnessConversationSummary,
  HarnessErrorCode,
  HarnessEvent,
  HarnessModelOption,
  HarnessPrincipal,
  HarnessRunSnapshot,
  HarnessTranscriptItem,
} from "@geminixiang/mikan-harness-web-contract";
import { createConversationEvent, createConversationMessage } from "../../adapter.js";
import { resolveConversationSettings } from "../../config.js";
import { SessionStore } from "../../harness/index.js";
import * as log from "../../log.js";
import { assertOfficeKey } from "../../office/index.js";
import type { Office } from "../../office/index.js";
import { resolveChannelSessionFile, resolveManagedSessionFile } from "../../sessions/store.js";
import { applyConversationSettings } from "../../settings-mutation.js";
import type { OfficeKey } from "../../types.js";
import { WebConversationResponder, WebMessagingBot, webMessagingInfo } from "./adapter.js";
import { WebConversationIdentity } from "./conversation-id.js";
import { HarnessEventJournal } from "./journal.js";
import {
  projectTranscript,
  sessionTitle,
  sessionUpdatedAt,
  titleFromPrompt,
} from "./transcript.js";
import type { HarnessHost, HarnessHostOptions, HarnessSubscription } from "./types.js";

interface ActiveRun {
  principalId: string;
  sessionId: string;
  runId: string;
  startedAt: string;
  stopping: boolean;
  stopRetry?: NodeJS.Timeout;
}

interface CachedCommand {
  signature: string;
  result: Promise<HarnessCommandResult>;
}

const COMMAND_CACHE_LIMIT = 500;

export class HarnessHostError extends Error {
  constructor(
    public readonly code: HarnessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HarnessHostError";
  }
}

/** Host-authoritative application service behind the browser transport. */
export class MikanHarnessHost implements HarnessHost {
  private readonly identity: WebConversationIdentity;
  private readonly journal = new HarnessEventJournal();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly commands = new Map<string, CachedCommand>();
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: HarnessHostOptions) {
    this.identity = new WebConversationIdentity(options.stateDir);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async bootstrap(
    principal: HarnessPrincipal,
    selectedOfficeKey?: string,
  ): Promise<HarnessBootstrap> {
    const cursor = this.journal.cursor(principal.id);
    const conversations = this.listConversations(principal);
    const selected = selectedOfficeKey
      ? this.resolveConversation(principal, selectedOfficeKey)
      : undefined;
    if (selectedOfficeKey && !selected) {
      throw new HarnessHostError("not-found", "Conversation not found");
    }
    const models = await this.listModels();
    return {
      principal,
      conversations,
      ...(selected ? { conversation: this.snapshot(selected) } : {}),
      models,
      cursor,
    };
  }

  async execute(
    principal: HarnessPrincipal,
    command: HarnessCommand,
  ): Promise<HarnessCommandResult> {
    const cacheKey = `${principal.id}\0${command.commandId}`;
    const signature = JSON.stringify(command);
    const existing = this.commands.get(cacheKey);
    if (existing) {
      if (existing.signature !== signature) {
        throw new HarnessHostError("invalid", "Command id was reused with different input");
      }
      return existing.result;
    }

    const result = this.executeNew(principal, command);
    this.commands.set(cacheKey, { signature, result });
    if (this.commands.size > COMMAND_CACHE_LIMIT) {
      const oldest = this.commands.keys().next().value;
      if (oldest !== undefined) this.commands.delete(oldest);
    }
    return result;
  }

  subscribe(
    principal: HarnessPrincipal,
    cursor: HarnessBootstrap["cursor"],
    emit: Parameters<HarnessHost["subscribe"]>[2],
  ): HarnessSubscription {
    return this.journal.subscribe(principal.id, cursor, emit);
  }

  private executeNew(
    principal: HarnessPrincipal,
    command: HarnessCommand,
  ): Promise<HarnessCommandResult> {
    switch (command.kind) {
      case "create-conversation":
        return Promise.resolve({
          kind: "conversation-created",
          conversation: this.createConversation(principal),
        });
      case "prompt":
        return Promise.resolve(this.startPrompt(principal, command));
      case "cancel-run":
        return Promise.resolve(this.cancelRun(principal, command));
      case "set-model":
        return this.setModel(principal, command);
    }
  }

  private createConversation(principal: HarnessPrincipal): HarnessConversationSnapshot {
    const address = this.identity.create(principal);
    const office = this.options.workspace.office(address);
    office.ensure();
    const sessionFile = resolveManagedSessionFile(office.sessionsDir, office.dir);
    const store = SessionStore.open(sessionFile);
    if (!store.getSessionName()) store.appendSessionInfo("New conversation");
    const conversation = this.snapshot(office);
    this.publish(principal.id, { kind: "conversation.created", conversation });
    return conversation;
  }

  private startPrompt(
    principal: HarnessPrincipal,
    command: Extract<HarnessCommand, { kind: "prompt" }>,
  ): HarnessCommandResult {
    const office = this.requireConversation(principal, command.officeKey);
    const store = this.requireSession(office, command.sessionId);
    const key = office.key;
    if (this.activeRuns.has(key)) {
      throw new HarnessHostError("conflict", "Conversation already has a running job");
    }
    if (sessionTitle(store) === "New conversation") {
      store.appendSessionInfo(titleFromPrompt(command.text));
    }

    const runId = this.createId();
    const startedAt = this.now().toISOString();
    const active: ActiveRun = {
      principalId: principal.id,
      sessionId: command.sessionId,
      runId,
      startedAt,
      stopping: false,
    };
    this.activeRuns.set(key, active);
    const userItem: HarnessTranscriptItem = {
      id: command.commandId,
      role: "user",
      title: "You",
      text: command.text,
      timestamp: startedAt,
    };
    this.publish(principal.id, {
      kind: "run.started",
      officeKey: key,
      sessionId: command.sessionId,
      run: this.runSnapshot(active),
      userItem,
    });
    this.publishSummary(principal.id, office);
    this.runPrompt(principal, office, command.text, active);
    return { kind: "prompt-accepted", runId };
  }

  private runPrompt(
    principal: HarnessPrincipal,
    office: Office,
    text: string,
    active: ActiveRun,
  ): void {
    const publish = (event: HarnessEvent): void => this.publish(principal.id, event);
    const responder = new WebConversationResponder(
      { officeKey: office.key, sessionId: active.sessionId, runId: active.runId },
      publish,
    );
    const platform = webMessagingInfo(principal.id, principal.displayName);
    const bot = new WebMessagingBot(responder, platform);
    const message = createConversationMessage({
      platform: "web",
      conversationId: office.address.conversationId,
      id: active.runId,
      sessionKey: office.address.conversationId,
      conversationKind: "direct",
      userId: principal.id,
      userName: principal.displayName,
      text,
    });
    const event = createConversationEvent({
      platform: "web",
      conversationId: office.address.conversationId,
      type: "web_message",
      commandMode: "prompt",
      conversationKind: "direct",
      ts: active.runId,
      user: principal.id,
      text,
      sessionKey: office.address.conversationId,
    });

    void this.options.runtime
      .handleEvent(event, bot, { address: office.address, message, responder, platform })
      .then(() => this.finishRun(office, active, "completed"))
      .catch((error: unknown) => {
        log.logWarning(
          `[${office.address.conversationId}] Web Harness run failed`,
          error instanceof Error ? error.message : String(error),
        );
        void responder.respondDiagnostic(
          error instanceof Error ? error.message : "The run failed unexpectedly.",
          { style: "error" },
        );
        this.finishRun(office, active, "failed");
      });
  }

  private finishRun(office: Office, active: ActiveRun, outcome: "completed" | "failed"): void {
    const current = this.activeRuns.get(office.key);
    if (current?.runId !== active.runId) return;
    this.activeRuns.delete(office.key);
    if (active.stopRetry) clearInterval(active.stopRetry);
    this.publish(active.principalId, {
      kind: "run.finished",
      officeKey: office.key,
      sessionId: active.sessionId,
      runId: active.runId,
      outcome: active.stopping ? "cancelled" : outcome,
    });
    this.publishSummary(active.principalId, office);
  }

  private requestRuntimeStop(office: Office, active: ActiveRun): void {
    const stop = (): void => {
      if (this.activeRuns.get(office.key)?.runId !== active.runId) {
        if (active.stopRetry) clearInterval(active.stopRetry);
        active.stopRetry = undefined;
        return;
      }
      this.options.runtime.forceStop(office.address, office.address.conversationId);
    };
    stop();
    active.stopRetry ??= setInterval(stop, 100);
    active.stopRetry.unref();
  }

  private cancelRun(
    principal: HarnessPrincipal,
    command: Extract<HarnessCommand, { kind: "cancel-run" }>,
  ): HarnessCommandResult {
    const office = this.requireConversation(principal, command.officeKey);
    this.requireSession(office, command.sessionId);
    const active = this.activeRuns.get(office.key);
    if (
      !active ||
      active.principalId !== principal.id ||
      active.sessionId !== command.sessionId ||
      active.runId !== command.runId
    ) {
      throw new HarnessHostError("conflict", "The selected run is no longer active");
    }
    active.stopping = true;
    this.requestRuntimeStop(office, active);
    this.publish(principal.id, {
      kind: "run.stopping",
      officeKey: office.key,
      sessionId: active.sessionId,
      runId: active.runId,
    });
    return { kind: "run-cancelled", runId: active.runId };
  }

  private async setModel(
    principal: HarnessPrincipal,
    command: Extract<HarnessCommand, { kind: "set-model" }>,
  ): Promise<HarnessCommandResult> {
    const office = this.requireConversation(principal, command.officeKey);
    this.requireSession(office, command.sessionId);
    const available = await this.options.models.getAvailable();
    if (
      !available.some((model) => model.provider === command.provider && model.id === command.model)
    ) {
      throw new HarnessHostError("invalid", "The selected model is not available");
    }
    const result = applyConversationSettings(this.options.runtime, office, {
      provider: command.provider,
      model: command.model,
      thinkingLevel: command.thinkingLevel,
    });
    if (!result.ok) {
      throw new HarnessHostError("conflict", "Model cannot change while a run is active");
    }
    const conversation = this.summary(office);
    this.publish(principal.id, {
      kind: "model.updated",
      officeKey: office.key,
      sessionId: command.sessionId,
      model: conversation.model,
    });
    this.publish(principal.id, { kind: "conversation.updated", conversation });
    return { kind: "model-updated", conversation };
  }

  private listConversations(principal: HarnessPrincipal): HarnessConversationSummary[] {
    return this.identity
      .listOwned(principal)
      .flatMap((address) => {
        const office = this.options.workspace.office(address);
        if (!existsSync(office.dir)) return [];
        try {
          return [this.summary(office)];
        } catch (error) {
          log.logWarning(
            `Skipping unreadable Web conversation ${office.key}`,
            error instanceof Error ? error.message : String(error),
          );
          return [];
        }
      })
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private resolveConversation(principal: HarnessPrincipal, keyValue: string): Office | undefined {
    let key: OfficeKey;
    try {
      key = assertOfficeKey(keyValue);
    } catch {
      return undefined;
    }
    const address = this.identity.resolveOwned(principal, key);
    if (!address) return undefined;
    const office = this.options.workspace.office(address);
    return existsSync(office.dir) ? office : undefined;
  }

  private requireConversation(principal: HarnessPrincipal, keyValue: string): Office {
    const office = this.resolveConversation(principal, keyValue);
    if (!office) throw new HarnessHostError("not-found", "Conversation was not found");
    return office;
  }

  private requireSession(office: Office, expectedId: string): SessionStore {
    const file = resolveChannelSessionFile(office.dir);
    if (!file) throw new HarnessHostError("not-found", "Conversation session was not found");
    const store = SessionStore.open(file);
    if (store.getHeader()?.id !== expectedId) {
      throw new HarnessHostError(
        "conflict",
        "Conversation session changed; reload before retrying",
      );
    }
    return store;
  }

  private summary(office: Office): HarnessConversationSummary {
    const store = this.currentSession(office);
    const header = store.getHeader();
    if (!header) throw new Error(`Web conversation has no session header: ${office.key}`);
    const config = resolveConversationSettings(office);
    const active = this.activeRuns.get(office.key);
    return {
      officeKey: office.key,
      title: sessionTitle(store),
      createdAt: header.timestamp,
      updatedAt: sessionUpdatedAt(store),
      sessionId: header.id,
      model: {
        provider: config.provider,
        model: config.model,
        thinkingLevel: config.thinkingLevel,
      },
      ...(active ? { run: this.runSnapshot(active) } : {}),
    };
  }

  private snapshot(office: Office): HarnessConversationSnapshot {
    const store = this.currentSession(office);
    return { ...this.summary(office), transcript: projectTranscript(store) };
  }

  private currentSession(office: Office): SessionStore {
    const file = resolveChannelSessionFile(office.dir);
    if (!file) throw new Error(`Web conversation has no current session: ${office.key}`);
    return SessionStore.open(file);
  }

  private runSnapshot(run: ActiveRun): HarnessRunSnapshot {
    return {
      id: run.runId,
      startedAt: run.startedAt,
      status: run.stopping ? "stopping" : "running",
    };
  }

  private publish(principalId: string, event: HarnessEvent): void {
    this.journal.publish(principalId, event);
  }

  private publishSummary(principalId: string, office: Office): void {
    try {
      this.publish(principalId, {
        kind: "conversation.updated",
        conversation: this.summary(office),
      });
    } catch (error) {
      log.logWarning(
        `Could not project Web conversation ${office.key}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async listModels(): Promise<HarnessModelOption[]> {
    const models = await this.options.models.getAvailable();
    return models
      .map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name || model.id,
        reasoning: model.reasoning,
      }))
      .toSorted((left, right) =>
        `${left.provider}/${left.name}`.localeCompare(`${right.provider}/${right.name}`),
      );
  }
}
