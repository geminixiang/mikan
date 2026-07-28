import { describe, expect, test, vi } from "vitest";
import type {
  MessagingBot,
  ConversationContext,
  ConversationEvent,
  MessagingEventHandler,
  OfficeAddress,
} from "../src/adapter.js";
import { matchMagicWord, processMessageIntake } from "../src/adapters/intake.js";
import type { MagicWordIntakeOptions, MessageIntakeOptions } from "../src/adapters/types.js";
import { createOfficeAddress } from "../src/office-address.js";

const address = createOfficeAddress("slack", "C1");

function makeEvent(overrides: Partial<ConversationEvent> = {}): ConversationEvent {
  return {
    type: "message",
    address,
    conversationId: "C1",
    conversationKind: "shared",
    ts: "M1",
    user: "U1",
    text: "hello",
    ...overrides,
  };
}

function makeHandler(runningKeys: string[] = []): MessagingEventHandler {
  const running = new Set(runningKeys);
  return {
    isRunning: vi.fn((_address: OfficeAddress, key: string) => running.has(key)),
    getRunningSessions: vi
      .fn()
      .mockReturnValue([...running].map((sessionKey) => ({ address, sessionKey, startedAt: 1 }))),
    handleEvent: vi.fn().mockResolvedValue(undefined),
    handleStop: vi.fn().mockResolvedValue(undefined),
    forceStop: vi.fn(),
    handleNewCommand: vi.fn().mockResolvedValue(undefined),
    handleExtensionAction: vi.fn().mockResolvedValue(false),
  };
}

function makeBot(): MessagingBot & { postMessage: ReturnType<typeof vi.fn> } {
  return {
    postMessage: vi.fn().mockResolvedValue("TS1"),
    getMessagingInfo: () => ({ name: "slack" }),
  } as unknown as MessagingBot & { postMessage: ReturnType<typeof vi.fn> };
}

const context = {} as ConversationContext;

function makeOptions(
  overrides: Partial<MessageIntakeOptions<ConversationEvent>> = {},
): MessageIntakeOptions<ConversationEvent> {
  return {
    eventBase: makeEvent(),
    workingDir: undefined,
    isAutoReplyCandidate: false,
    magicWord: { addressed: true, scopeFallback: "top-level" },
    busyPolicy: "queue",
    logEntryBase: {},
    processAttachments: vi.fn().mockResolvedValue([]),
    queueKey: "C1",
    enqueue: vi.fn(),
    handler: makeHandler(),
    bot: makeBot(),
    createContext: vi.fn().mockReturnValue(context),
    ...overrides,
  };
}

describe("processMessageIntake identity", () => {
  test("rejects an explicit session key owned by another conversation before queueing", async () => {
    const enqueue = vi.fn();
    await expect(
      processMessageIntake(
        makeOptions({
          eventBase: makeEvent({ conversationId: "C1", sessionKey: "C2:thread-1" }),
          enqueue,
        }),
      ),
    ).rejects.toThrow(/does not belong/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("rejects a path-dangerous conversation identity before queueing", async () => {
    const enqueue = vi.fn();
    await expect(
      processMessageIntake(
        makeOptions({
          eventBase: makeEvent({ conversationId: "../other" }),
          enqueue,
        }),
      ),
    ).rejects.toThrow(/path separators/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("matchMagicWord", () => {
  test.each(["stop", "/stop", "Stop", "STOP", " stop ", "/stop@mikan_bot", "stop@mikan_bot"])(
    "recognizes %j as the stop magic word",
    (text) => {
      expect(matchMagicWord(text)).toBe("stop");
    },
  );

  test.each(["stop it", "please stop", "restop", "//stop", "stopping", ""])(
    "does not match %j",
    (text) => {
      expect(matchMagicWord(text)).toBeNull();
    },
  );
});

describe("processMessageIntake magic word", () => {
  test("stops the running session directly, logs, and never queues", async () => {
    const handler = makeHandler(["C1:T1"]);
    const log = vi.fn();
    const enqueue = vi.fn();
    const options = makeOptions({
      eventBase: makeEvent({ text: "stop", sessionKey: "C1:T1" }),
      handler,
      log,
      enqueue,
      logEntryBase: { text: "stop" },
    });

    const outcome = await processMessageIntake(options);

    expect(outcome).toBe("magic-word");
    expect(handler.handleStop).toHaveBeenCalledWith(address, "C1:T1", options.bot);
    expect(log).toHaveBeenCalledWith({ text: "stop", attachments: [] });
    expect(enqueue).not.toHaveBeenCalled();
    expect(handler.handleEvent).not.toHaveBeenCalled();
    expect(options.processAttachments).not.toHaveBeenCalled();
  });

  test("magic word bypasses the trigger gate for auto-reply candidates", async () => {
    const handler = makeHandler(["C1"]);
    const options = makeOptions({
      eventBase: makeEvent({ text: "/stop", sessionKey: "C1" }),
      isAutoReplyCandidate: true,
      magicWord: { addressed: false, scopeFallback: "top-level" },
      handler,
    });

    expect(await processMessageIntake(options)).toBe("magic-word");
    expect(handler.handleStop).toHaveBeenCalledWith(address, "C1", options.bot);
  });

  test("matches the dedicated magicWord.text when the event text is decorated", async () => {
    const handler = makeHandler(["C1"]);
    const options = makeOptions({
      eventBase: makeEvent({ text: "[PR review comment rc-9 on a.ts:3]\n> diff\n\nstop" }),
      magicWord: { text: "stop", addressed: true, scopeFallback: "never" },
      handler,
    });

    expect(await processMessageIntake(options)).toBe("magic-word");
    expect(handler.handleStop).toHaveBeenCalled();
  });

  test("falls back from a not-running thread session to the running conversation session", async () => {
    const handler = makeHandler(["C1"]);
    const options = makeOptions({
      eventBase: makeEvent({ text: "stop", sessionKey: "C1:T1" }),
      handler,
    });

    await processMessageIntake(options);

    expect(handler.handleStop).toHaveBeenCalledWith(address, "C1", options.bot);
  });

  test("replies 'Nothing running' only when the message addressed the bot", async () => {
    const addressedOptions = makeOptions({
      eventBase: makeEvent({ text: "stop", sessionKey: "C1" }),
    });
    await processMessageIntake(addressedOptions);
    expect(addressedOptions.bot.postMessage).toHaveBeenCalledWith("C1", expect.any(String));

    const unaddressedOptions = makeOptions({
      eventBase: makeEvent({ text: "stop", sessionKey: "C1" }),
      magicWord: { addressed: false, scopeFallback: "top-level" },
    });
    await processMessageIntake(unaddressedOptions);
    expect(unaddressedOptions.bot.postMessage).not.toHaveBeenCalled();
  });

  describe("scope fallback", () => {
    const scoped = (
      scopeFallback: MagicWordIntakeOptions["scopeFallback"],
      sessionKey: string | undefined,
      runningKeys: string[],
    ) => {
      const handler = makeHandler(runningKeys);
      return {
        handler,
        run: () =>
          processMessageIntake(
            makeOptions({
              eventBase: makeEvent({ text: "stop", sessionKey }),
              magicWord: { addressed: true, scopeFallback },
              handler,
            }),
          ),
      };
    };

    test("top-level: a conversation-session stop widens to the only running scoped session", async () => {
      const { handler, run } = scoped("top-level", "C1", ["C1:T1"]);
      await run();
      expect(handler.handleStop).toHaveBeenCalledWith(address, "C1:T1", expect.anything());
    });

    test("top-level: an undefined session key also widens", async () => {
      const { handler, run } = scoped("top-level", undefined, ["C1:T1"]);
      await run();
      expect(handler.handleStop).toHaveBeenCalledWith(address, "C1:T1", expect.anything());
    });

    test("top-level: a thread-session stop does not widen", async () => {
      const { handler, run } = scoped("top-level", "C1:T2", ["C1:T1"]);
      await run();
      expect(handler.handleStop).not.toHaveBeenCalled();
    });

    test("top-level: ambiguous scoped sessions never widen", async () => {
      const { handler, run } = scoped("top-level", "C1", ["C1:T1", "C1:T2"]);
      await run();
      expect(handler.handleStop).not.toHaveBeenCalled();
    });

    test("always: a thread-session stop widens to the only running scoped session", async () => {
      const { handler, run } = scoped("always", "C1:T2", ["C1:T1"]);
      await run();
      expect(handler.handleStop).toHaveBeenCalledWith(address, "C1:T1", expect.anything());
    });

    test("never: only exact session or conversation matches stop", async () => {
      const { handler, run } = scoped("never", "C1", ["C1:T1"]);
      await run();
      expect(handler.handleStop).not.toHaveBeenCalled();
    });

    test("a running direct target always wins over widening", async () => {
      const { handler, run } = scoped("always", "C1:T1", ["C1", "C1:T1"]);
      await run();
      expect(handler.handleStop).toHaveBeenCalledWith(address, "C1:T1", expect.anything());
    });
  });
});

describe("processMessageIntake busy policy", () => {
  test("reject: bounces with 'Already working' when the session is running", async () => {
    const handler = makeHandler(["C1"]);
    const enqueue = vi.fn();
    const log = vi.fn();
    const options = makeOptions({
      eventBase: makeEvent({ sessionKey: "C1" }),
      busyPolicy: "reject",
      handler,
      enqueue,
      log,
      logEntryBase: { text: "hello" },
    });

    const outcome = await processMessageIntake(options);

    expect(outcome).toBe("rejected-busy");
    expect(options.bot.postMessage).toHaveBeenCalledWith("C1", expect.stringContaining("/stop"));
    expect(enqueue).not.toHaveBeenCalled();
    // The rejected message is still logged (with its prepared attachments).
    expect(log).toHaveBeenCalledWith({ text: "hello", attachments: [] });
  });

  test("reject: enqueues normally when the session is idle", async () => {
    const enqueue = vi.fn();
    const options = makeOptions({
      eventBase: makeEvent({ sessionKey: "C1" }),
      busyPolicy: "reject",
      enqueue,
    });

    expect(await processMessageIntake(options)).toBe("enqueued");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(options.bot.postMessage).not.toHaveBeenCalled();
  });

  test("queue: lines the message up even while the session is running", async () => {
    const handler = makeHandler(["C1"]);
    const enqueue = vi.fn();
    const options = makeOptions({
      eventBase: makeEvent({ sessionKey: "C1" }),
      busyPolicy: "queue",
      handler,
      enqueue,
    });

    expect(await processMessageIntake(options)).toBe("enqueued");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("processMessageIntake", () => {
  test("logs non-triggered auto-reply candidates without queueing", async () => {
    const handler = makeHandler();
    const log = vi.fn();
    const enqueue = vi.fn();

    const outcome = await processMessageIntake(
      makeOptions({
        isAutoReplyCandidate: true,
        logEntryBase: { text: "hello" },
        log,
        processAttachments: vi.fn().mockResolvedValue([{ name: "a.txt", localPath: "C1/a.txt" }]),
        enqueue,
        handler,
      }),
    );

    expect(outcome).toBe("not-triggered");
    expect(log).toHaveBeenCalledWith({ text: "hello", attachments: [] });
    expect(enqueue).not.toHaveBeenCalled();
    expect(handler.handleEvent).not.toHaveBeenCalled();
  });

  test("prepares attachments, logs, then enqueues addressed messages", async () => {
    const handler = makeHandler();
    const work: Array<() => Promise<void>> = [];
    const attachments = [{ name: "a.txt", localPath: "C1/a.txt" }];
    const log = vi.fn();
    const createContext = vi.fn().mockReturnValue(context);
    const bot = makeBot();

    const outcome = await processMessageIntake(
      makeOptions({
        logEntryBase: { text: "hello" },
        log,
        processAttachments: vi.fn().mockResolvedValue(attachments),
        enqueue: (_queueKey, queuedWork) => work.push(queuedWork),
        handler,
        bot,
        createContext,
      }),
    );

    expect(outcome).toBe("enqueued");
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

    const outcome = await processMessageIntake(
      makeOptions({
        processAttachments,
        enqueue: (_queueKey, queuedWork) => work.push(queuedWork),
        handler,
        deferAttachmentsUntilRun: true,
      }),
    );

    expect(outcome).toBe("enqueued");
    expect(work).toHaveLength(1);
    expect(processAttachments).not.toHaveBeenCalled();

    await work[0]!();

    expect(processAttachments).toHaveBeenCalledTimes(1);
    expect(handler.handleEvent).toHaveBeenCalledTimes(1);
  });

  test("deferred busy rejection happens inside the queued work", async () => {
    const handler = makeHandler(["C1"]);
    const work: Array<() => Promise<void>> = [];
    const options = makeOptions({
      eventBase: makeEvent({ sessionKey: "C1" }),
      busyPolicy: "reject",
      enqueue: (_queueKey, queuedWork) => work.push(queuedWork),
      handler,
      deferAttachmentsUntilRun: true,
    });

    expect(await processMessageIntake(options)).toBe("enqueued");

    await work[0]!();

    expect(handler.handleEvent).not.toHaveBeenCalled();
    expect(options.bot.postMessage).toHaveBeenCalledWith("C1", expect.stringContaining("/stop"));
  });

  test.each([false, true])("propagates attachment failures (deferred: %s)", async (deferred) => {
    const failure = new Error("attachment failed");
    const work: Array<() => Promise<void>> = [];
    const intake = processMessageIntake(
      makeOptions({
        processAttachments: vi.fn().mockRejectedValue(failure),
        enqueue: (_queueKey, queuedWork) => work.push(queuedWork),
        deferAttachmentsUntilRun: deferred,
      }),
    );

    if (deferred) {
      await intake;
      await expect(work[0]!()).rejects.toBe(failure);
    } else {
      await expect(intake).rejects.toBe(failure);
    }
  });
});
