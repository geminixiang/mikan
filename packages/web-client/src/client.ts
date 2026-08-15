import type {
  HarnessCommandResult,
  HarnessConversationSnapshot,
  HarnessConversationSummary,
  HarnessEventEnvelope,
  HarnessThinkingLevel,
  HarnessTranscriptItem,
} from "@geminixiang/mikan-harness-web-contract";
import { HarnessApiError } from "./transport.js";
import type { HarnessClientActions, HarnessClientSnapshot, HarnessHostPort } from "./types.js";

type SnapshotListener = () => void;

const EMPTY_SNAPSHOT: HarnessClientSnapshot = {
  status: "loading",
  connection: "connecting",
  conversations: [],
  models: [],
};

/** React-free browser authority for Harness projection, intents, and reconnect. */
export class HarnessClient implements HarnessClientActions {
  private snapshot: HarnessClientSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<SnapshotListener>();
  private streamDispose: (() => void) | undefined;
  private selectedOfficeKey: string | undefined;
  private cursor: HarnessEventEnvelope["cursor"] | undefined;
  private loadGeneration = 0;

  constructor(private readonly port: HarnessHostPort) {}

  getSnapshot = (): HarnessClientSnapshot => this.snapshot;

  subscribe = (listener: SnapshotListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async open(officeKey?: string): Promise<void> {
    const generation = ++this.loadGeneration;
    this.selectedOfficeKey = officeKey;
    this.update({
      ...this.snapshot,
      status: this.snapshot.principal ? "ready" : "loading",
      connection: "connecting",
      error: undefined,
    });
    try {
      const bootstrap = await this.port.bootstrap(officeKey);
      if (generation !== this.loadGeneration) return;
      this.cursor = bootstrap.cursor;
      this.update({
        status: "ready",
        connection: "connecting",
        principal: bootstrap.principal,
        conversations: bootstrap.conversations,
        conversation: bootstrap.conversation,
        models: bootstrap.models,
      });
      this.connect(bootstrap.cursor, generation);
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.streamDispose?.();
      this.streamDispose = undefined;
      this.update({
        ...this.snapshot,
        status:
          error instanceof HarnessApiError && error.status === 401 ? "unauthenticated" : "error",
        connection: "reconnecting",
        error: errorMessage(error),
      });
    }
  }

  async createConversation(): Promise<string> {
    try {
      const result = await this.execute({
        kind: "create-conversation",
        commandId: crypto.randomUUID(),
      });
      if (result.kind !== "conversation-created") throw new Error("Unexpected create result");
      this.update({
        ...this.snapshot,
        conversations: upsertSummary(this.snapshot.conversations, result.conversation),
        error: undefined,
      });
      return result.conversation.officeKey;
    } catch (error) {
      this.setActionError(error);
      throw error;
    }
  }

  async prompt(text: string): Promise<void> {
    const conversation = this.requireConversation();
    if (conversation.run) throw new Error("This conversation is already running");
    const normalized = text.trim();
    if (!normalized) return;
    const commandId = crypto.randomUUID();
    const optimistic = transcriptItem(commandId, "user", "You", normalized);
    const pendingRun = {
      id: `pending-${commandId}`,
      startedAt: new Date().toISOString(),
      status: "running" as const,
    };
    this.replaceConversation({
      ...conversation,
      transcript: appendUnique(conversation.transcript, optimistic),
      run: pendingRun,
    });

    try {
      const result = await this.execute({
        kind: "prompt",
        commandId,
        officeKey: conversation.officeKey,
        sessionId: conversation.sessionId,
        text: normalized,
      });
      if (result.kind !== "prompt-accepted") throw new Error("Unexpected prompt result");
      const current = this.snapshot.conversation;
      if (current?.run?.id === pendingRun.id) {
        this.replaceConversation({
          ...current,
          run: { ...pendingRun, id: result.runId },
        });
      }
    } catch (error) {
      const current = this.snapshot.conversation;
      // The command may have been accepted even when its HTTP response was
      // lost. A host-issued run event is stronger evidence than fetch failure.
      if (current?.run && current.run.id !== pendingRun.id) return;
      if (current?.officeKey === conversation.officeKey) {
        this.replaceConversation({
          ...current,
          transcript: current.transcript.filter((item) => item.id !== commandId),
          run: current.run?.id === pendingRun.id ? undefined : current.run,
        });
      }
      this.setActionError(error);
      throw error;
    }
  }

  async cancel(): Promise<void> {
    try {
      const conversation = this.requireConversation();
      const run = conversation.run;
      if (!run || run.id.startsWith("pending-")) return;
      const result = await this.execute({
        kind: "cancel-run",
        commandId: crypto.randomUUID(),
        officeKey: conversation.officeKey,
        sessionId: conversation.sessionId,
        runId: run.id,
      });
      if (result.kind !== "run-cancelled") throw new Error("Unexpected cancel result");
      const current = this.snapshot.conversation;
      if (current?.officeKey === conversation.officeKey && current.run?.id === run.id) {
        this.replaceConversation({ ...current, run: { ...current.run, status: "stopping" } });
      }
    } catch (error) {
      this.setActionError(error);
      throw error;
    }
  }

  async setModel(
    provider: string,
    model: string,
    thinkingLevel: HarnessThinkingLevel,
  ): Promise<void> {
    try {
      const conversation = this.requireConversation();
      const result = await this.execute({
        kind: "set-model",
        commandId: crypto.randomUUID(),
        officeKey: conversation.officeKey,
        sessionId: conversation.sessionId,
        provider,
        model,
        thinkingLevel,
      });
      if (result.kind !== "model-updated") throw new Error("Unexpected model result");
      this.applySummary(result.conversation);
    } catch (error) {
      this.setActionError(error);
      throw error;
    }
  }

  async logout(): Promise<void> {
    try {
      await this.port.logout();
      this.dispose();
      this.update({ ...EMPTY_SNAPSHOT, status: "unauthenticated" });
    } catch (error) {
      this.setActionError(error);
      throw error;
    }
  }

  dispose(): void {
    this.loadGeneration++;
    this.streamDispose?.();
    this.streamDispose = undefined;
  }

  private connect(cursor: HarnessEventEnvelope["cursor"], generation: number): void {
    this.streamDispose?.();
    this.streamDispose = this.port.subscribe(
      cursor,
      (event) => this.receive(event, generation),
      () => void this.open(this.selectedOfficeKey),
      (connection) => {
        if (generation === this.loadGeneration) this.update({ ...this.snapshot, connection });
      },
    );
  }

  private receive(envelope: HarnessEventEnvelope, generation: number): void {
    if (generation !== this.loadGeneration) return;
    const cursor = this.cursor;
    if (!cursor || envelope.cursor.epoch !== cursor.epoch) {
      void this.open(this.selectedOfficeKey);
      return;
    }
    if (envelope.cursor.sequence <= cursor.sequence) return;
    if (envelope.cursor.sequence !== cursor.sequence + 1) {
      void this.open(this.selectedOfficeKey);
      return;
    }
    this.cursor = envelope.cursor;
    this.applyEvent(envelope);
  }

  private applyEvent(envelope: HarnessEventEnvelope): void {
    const event = envelope.event;
    if (event.kind === "conversation.created" || event.kind === "conversation.updated") {
      this.applySummary(event.conversation);
      return;
    }
    if (event.kind === "model.updated") {
      const active = this.snapshot.conversation;
      if (active?.officeKey === event.officeKey && active.sessionId === event.sessionId) {
        this.applySummary({ ...active, model: event.model });
      }
      return;
    }
    const active = this.snapshot.conversation;
    if (!active || active.officeKey !== event.officeKey || active.sessionId !== event.sessionId) {
      return;
    }
    this.applyConversationEvent(active, envelope);
  }

  private applyConversationEvent(
    active: HarnessConversationSnapshot,
    envelope: HarnessEventEnvelope,
  ): void {
    const event = envelope.event;
    if (event.kind === "run.started") {
      this.replaceConversation({
        ...active,
        transcript: appendUnique(active.transcript, event.userItem),
        run: event.run,
      });
      return;
    }
    if (event.kind === "run.stopping") {
      if (active.run?.id === event.runId) {
        this.replaceConversation({ ...active, run: { ...active.run, status: "stopping" } });
      }
      return;
    }
    if (event.kind === "response.delta") {
      this.upsertLiveResponse(active, event.runId, (text) => text + event.delta);
      return;
    }
    if (event.kind === "response.replaced" || event.kind === "response.finished") {
      this.upsertLiveResponse(active, event.runId, () => event.text);
      return;
    }
    if (event.kind === "diagnostic") {
      this.replaceConversation({
        ...active,
        transcript: appendUnique(
          active.transcript,
          transcriptItem(
            `event-${envelope.cursor.sequence}`,
            "system",
            "Status",
            event.text,
            event.tone === "error" ? "error" : "muted",
          ),
        ),
      });
      return;
    }
    if (event.kind === "tool.result") {
      this.replaceConversation({
        ...active,
        transcript: appendUnique(
          active.transcript,
          transcriptItem(
            `event-${envelope.cursor.sequence}`,
            "tool",
            event.title,
            event.text,
            event.tone,
          ),
        ),
      });
      return;
    }
    if (event.kind === "run.finished" && active.run?.id === event.runId) {
      this.replaceConversation({ ...active, run: undefined });
      void this.open(active.officeKey);
    }
  }

  private upsertLiveResponse(
    active: HarnessConversationSnapshot,
    runId: string,
    updateText: (text: string) => string,
  ): void {
    const id = `live-${runId}`;
    const existing = active.transcript.find((item) => item.id === id);
    const next = transcriptItem(id, "assistant", "mikan", updateText(existing?.text ?? ""));
    this.replaceConversation({
      ...active,
      transcript: existing
        ? active.transcript.map((item) => (item.id === id ? next : item))
        : [...active.transcript, next],
    });
  }

  private applySummary(summary: HarnessConversationSummary): void {
    const active = this.snapshot.conversation;
    this.update({
      ...this.snapshot,
      conversations: upsertSummary(this.snapshot.conversations, summary),
      conversation:
        active?.officeKey === summary.officeKey
          ? { ...active, ...summary, transcript: active.transcript }
          : active,
      error: undefined,
    });
  }

  private replaceConversation(conversation: HarnessConversationSnapshot): void {
    this.update({
      ...this.snapshot,
      conversation,
      conversations: upsertSummary(this.snapshot.conversations, conversation),
      error: undefined,
    });
  }

  private requireConversation(): HarnessConversationSnapshot {
    const conversation = this.snapshot.conversation;
    if (!conversation) throw new Error("Open a conversation first");
    return conversation;
  }

  private execute(
    command: Parameters<HarnessHostPort["execute"]>[0],
  ): Promise<HarnessCommandResult> {
    return this.port.execute(command);
  }

  private setActionError(error: unknown): void {
    this.update({ ...this.snapshot, error: errorMessage(error) });
  }

  private update(snapshot: HarnessClientSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

function upsertSummary(
  conversations: HarnessConversationSummary[],
  summary: HarnessConversationSummary,
): HarnessConversationSummary[] {
  const existing = conversations.findIndex((item) => item.officeKey === summary.officeKey);
  const next =
    existing === -1
      ? [...conversations, summary]
      : conversations.map((item, index) => (index === existing ? summary : item));
  return next.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function appendUnique(
  items: HarnessTranscriptItem[],
  item: HarnessTranscriptItem,
): HarnessTranscriptItem[] {
  return items.some((existing) => existing.id === item.id) ? items : [...items, item];
}

function transcriptItem(
  id: string,
  role: HarnessTranscriptItem["role"],
  title: string,
  text: string,
  tone?: HarnessTranscriptItem["tone"],
): HarnessTranscriptItem {
  return {
    id,
    role,
    title,
    text,
    timestamp: new Date().toISOString(),
    ...(tone ? { tone } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
