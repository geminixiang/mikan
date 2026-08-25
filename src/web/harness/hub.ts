import { randomUUID } from "node:crypto";
import type { SubagentProgressNode } from "../../types.js";
import type { WebQueueItem, WebRunSnapshot, WebStreamFrame, WebToolSnapshot } from "./protocol.js";

export interface WebTransientState {
  readonly run: WebRunSnapshot | null;
  readonly queue: readonly WebQueueItem[];
  readonly subagents: readonly SubagentProgressNode[];
  readonly tools: readonly WebToolSnapshot[];
}

export interface WebStreamSubscription {
  readonly initial: WebTransientState;
  flush(bootstrap: readonly WebStreamFrame[]): void;
  close(): void;
}

interface WebStreamSubscriber {
  readonly send: (frame: WebStreamFrame) => void;
}

interface MutableTransientState {
  run: WebRunSnapshot | null;
  queue: readonly WebQueueItem[];
  subagents: readonly SubagentProgressNode[];
  tools: Map<string, WebToolSnapshot>;
}

function emptyTransientState(): MutableTransientState {
  return { run: null, queue: [], subagents: [], tools: new Map() };
}

/** Process-local transient stream state. Durable conversation truth stays in pi sessions. */
export class WebEventHub {
  readonly generation = randomUUID();
  private readonly subscribers = new Map<string, Set<WebStreamSubscriber>>();
  private readonly states = new Map<string, MutableTransientState>();

  snapshot(workspaceId: string): WebTransientState {
    const state = this.states.get(workspaceId) ?? emptyTransientState();
    return {
      run: state.run,
      queue: [...state.queue],
      subagents: [...state.subagents],
      tools: Array.from(state.tools.values()),
    };
  }

  publish(workspaceId: string, frame: WebStreamFrame): void {
    this.capture(workspaceId, frame);
    for (const subscriber of this.subscribers.get(workspaceId) ?? []) {
      subscriber.send(frame);
    }
  }

  /** Buffer live frames until durable reconnect state has been emitted. */
  subscribe(workspaceId: string, send: (frame: WebStreamFrame) => void): WebStreamSubscription {
    const bucket = this.subscribers.get(workspaceId) ?? new Set<WebStreamSubscriber>();
    this.subscribers.set(workspaceId, bucket);
    let pending: WebStreamFrame[] | null = [];
    const subscriber: WebStreamSubscriber = {
      send: (frame) => {
        if (pending) pending.push(frame);
        else send(frame);
      },
    };
    bucket.add(subscriber);
    const initial = this.snapshot(workspaceId);

    let closed = false;
    return {
      initial,
      flush: (bootstrap) => {
        if (closed || !pending) return;
        const buffered = pending;
        for (const frame of bootstrap) send(frame);
        for (const frame of buffered) send(frame);
        pending = null;
      },
      close: () => {
        if (closed) return;
        closed = true;
        bucket.delete(subscriber);
        if (bucket.size === 0) this.subscribers.delete(workspaceId);
        pending = null;
      },
    };
  }

  clear(workspaceId: string): void {
    this.states.delete(workspaceId);
  }

  private capture(workspaceId: string, frame: WebStreamFrame): void {
    const current = this.states.get(workspaceId) ?? emptyTransientState();
    if (frame.type === "run.snapshot") {
      current.run = frame.run;
      if (!frame.run) {
        current.subagents = [];
        current.tools.clear();
      }
    } else if (frame.type === "queue.snapshot") {
      current.queue = [...frame.items];
    } else if (frame.type === "subagents.snapshot") {
      current.subagents = [...frame.items];
    } else if (frame.type === "tool.started") {
      current.tools.set(frame.tool.id, frame.tool);
    } else if (frame.type === "tool.finished") {
      current.tools.delete(frame.tool.id);
    } else {
      return;
    }
    this.states.set(workspaceId, current);
  }
}
