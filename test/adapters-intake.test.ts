import { describe, expect, test, vi } from "vitest";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
} from "../src/adapter.js";
import { processMessageIntake } from "../src/adapters/intake.js";

function makeEvent(overrides: Partial<ConversationEvent> = {}): ConversationEvent {
  return {
    type: "message",
    conversationId: "C1",
    conversationKind: "shared",
    ts: "M1",
    user: "U1",
    text: "hello",
    ...overrides,
  };
}

function makeHandler(): MessagingEventHandler {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    getRunningSessions: vi.fn().mockReturnValue([]),
    handleEvent: vi.fn().mockResolvedValue(undefined),
    handleStop: vi.fn().mockResolvedValue(undefined),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn().mockResolvedValue(undefined),
  };
}

const bot = {} as MessagingBot;
const context = {} as ConversationContext;

describe("processMessageIntake", () => {
  test("logs non-triggered auto-reply candidates without queueing", async () => {
    const handler = makeHandler();
    const log = vi.fn();
    const enqueue = vi.fn();
    const onNotTriggered = vi.fn();

    await processMessageIntake({
      eventBase: makeEvent(),
      workingDir: undefined,
      isAutoReplyCandidate: true,
      logEntryBase: { text: "hello" },
      log,
      processAttachments: vi.fn().mockResolvedValue([{ name: "a.txt", localPath: "C1/a.txt" }]),
      queueKey: "C1",
      enqueue,
      handler,
      bot,
      createContext: vi.fn().mockReturnValue(context),
      onNotTriggered,
    });

    expect(log).toHaveBeenCalledWith({ text: "hello", attachments: [] });
    expect(onNotTriggered).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("prepares attachments, logs, then enqueues addressed messages", async () => {
    const handler = makeHandler();
    const work: Array<() => Promise<void>> = [];
    const attachments = [{ name: "a.txt", localPath: "C1/a.txt" }];
    const log = vi.fn();
    const createContext = vi.fn().mockReturnValue(context);

    await processMessageIntake({
      eventBase: makeEvent(),
      workingDir: undefined,
      isAutoReplyCandidate: false,
      logEntryBase: { text: "hello" },
      log,
      processAttachments: vi.fn().mockResolvedValue(attachments),
      queueKey: "C1",
      enqueue: (_queueKey, queuedWork) => work.push(queuedWork),
      handler,
      bot,
      createContext,
    });

    expect(log).toHaveBeenCalledWith({ text: "hello", attachments });
    expect(work).toHaveLength(1);
    expect(handler.handleEvent).not.toHaveBeenCalled();

    await work[0]!();

    expect(createContext).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
    expect(handler.handleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ attachments }),
      bot,
      context,
    );
  });

  test("can defer attachment work until the queued run starts", async () => {
    const handler = makeHandler();
    const work: Array<() => Promise<void>> = [];
    const processAttachments = vi.fn().mockResolvedValue([]);

    await processMessageIntake({
      eventBase: makeEvent(),
      workingDir: undefined,
      isAutoReplyCandidate: false,
      logEntryBase: {},
      processAttachments,
      queueKey: "C1",
      enqueue: (_queueKey, queuedWork) => work.push(queuedWork),
      handler,
      bot,
      createContext: vi.fn().mockReturnValue(context),
      deferAttachmentsUntilRun: true,
    });

    expect(work).toHaveLength(1);
    expect(processAttachments).not.toHaveBeenCalled();

    await work[0]!();

    expect(processAttachments).toHaveBeenCalledTimes(1);
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
  });
});
