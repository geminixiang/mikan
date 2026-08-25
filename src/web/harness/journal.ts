import { randomUUID } from "node:crypto";
import type {
  HarnessCursor,
  HarnessEvent,
  HarnessEventEnvelope,
} from "@geminixiang/mikan-harness-web-contract";
import type { HarnessSubscription } from "./types.js";

type JournalListener = (event: HarnessEventEnvelope) => void;

interface PrincipalJournal {
  sequence: number;
  events: HarnessEventEnvelope[];
  listeners: Set<JournalListener>;
}

const DEFAULT_REPLAY_LIMIT = 1_000;

/** Ordered, resumable in-process event journal scoped independently per principal. */
export class HarnessEventJournal {
  private readonly epoch = randomUUID();
  private readonly principals = new Map<string, PrincipalJournal>();

  constructor(private readonly replayLimit = DEFAULT_REPLAY_LIMIT) {}

  cursor(principalId: string): HarnessCursor {
    return { epoch: this.epoch, sequence: this.get(principalId).sequence };
  }

  publish(principalId: string, event: HarnessEvent): HarnessEventEnvelope {
    const journal = this.get(principalId);
    const envelope: HarnessEventEnvelope = {
      cursor: { epoch: this.epoch, sequence: ++journal.sequence },
      event,
    };
    journal.events.push(envelope);
    if (journal.events.length > this.replayLimit) journal.events.shift();
    for (const listener of journal.listeners) {
      try {
        listener(envelope);
      } catch {
        journal.listeners.delete(listener);
      }
    }
    return envelope;
  }

  subscribe(
    principalId: string,
    cursor: HarnessCursor,
    emit: JournalListener,
  ): HarnessSubscription {
    const journal = this.get(principalId);
    const oldest = journal.events[0]?.cursor.sequence ?? journal.sequence + 1;
    if (
      cursor.epoch !== this.epoch ||
      cursor.sequence > journal.sequence ||
      cursor.sequence < oldest - 1
    ) {
      return { kind: "reset", cursor: this.cursor(principalId) };
    }

    const replay = journal.events.filter((event) => event.cursor.sequence > cursor.sequence);
    journal.listeners.add(emit);
    for (const event of replay) {
      try {
        emit(event);
      } catch {
        journal.listeners.delete(emit);
        break;
      }
    }
    return {
      kind: "subscribed",
      dispose: () => journal.listeners.delete(emit),
    };
  }

  private get(principalId: string): PrincipalJournal {
    let journal = this.principals.get(principalId);
    if (!journal) {
      journal = { sequence: 0, events: [], listeners: new Set() };
      this.principals.set(principalId, journal);
    }
    return journal;
  }
}
