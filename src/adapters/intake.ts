import { assertSessionKeyBelongsToConversation } from "../sessions/session-key.js";
import type { ConversationEvent } from "../types.js";
import { formatAlreadyWorking, formatNothingRunning } from "./messages.js";
import { resolveOnlyScopedStopTarget, resolveStopTarget } from "./shared.js";
import type { MessageIntakeOptions, MessageIntakeOutcome } from "./types.js";

export function matchMagicWord(text: string): "stop" | null {
  return /^\/?stop(?:@\w+)?$/i.test(text.trim()) ? "stop" : null;
}

export async function processMessageIntake<TEvent extends ConversationEvent>(
  options: MessageIntakeOptions<TEvent>,
): Promise<MessageIntakeOutcome> {
  const conversationId = options.eventBase.address.conversationId;
  if (options.eventBase.sessionKey !== undefined) {
    assertSessionKeyBelongsToConversation(options.eventBase.sessionKey, conversationId);
  }
  if (matchMagicWord(options.magicWord.text ?? options.eventBase.text) === "stop") {
    options.log?.({ ...options.logEntryBase, attachments: [] });
    await handleStopMagicWord(options);
    return "magic-word";
  }

  if (!options.addressed) {
    options.log?.({ ...options.logEntryBase, attachments: [] });
    return "not-triggered";
  }

  function prepareEvent(attachments: unknown[]): TEvent {
    const event = { ...options.eventBase, attachments } as TEvent;
    options.log?.({ ...options.logEntryBase, attachments });
    return event;
  }

  async function rejectedWhileBusy(): Promise<boolean> {
    const sessionKey = options.eventBase.sessionKey ?? conversationId;
    if (!options.handler.isRunning(options.eventBase.address, sessionKey)) return false;
    await options.bot.postMessage(conversationId, formatAlreadyWorking(options.bot, "/stop"));
    return true;
  }

  function dispatch(event: TEvent): Promise<void> {
    const context = options.createContext(event);
    return options.handler.handleEvent(event, options.bot, context);
  }

  if (options.deferAttachmentsUntilRun) {
    options.enqueue(options.queueKey, async () => {
      const event = prepareEvent(await options.processAttachments());
      if (options.busyPolicy === "reject" && (await rejectedWhileBusy())) return;
      return dispatch(event);
    });
    return "enqueued";
  }

  const event = prepareEvent(await options.processAttachments());
  if (options.busyPolicy === "reject" && (await rejectedWhileBusy())) return "rejected-busy";
  options.enqueue(options.queueKey, () => dispatch(event));
  return "enqueued";
}

async function handleStopMagicWord<TEvent extends ConversationEvent>(
  options: MessageIntakeOptions<TEvent>,
): Promise<void> {
  const { handler, bot, eventBase, magicWord } = options;
  const address = eventBase.address;
  const conversationId = address.conversationId;
  const sessionKey = eventBase.sessionKey;

  let target = resolveStopTarget({ handler, address, sessionKey });
  if (!target && widensToScopedSession(magicWord.scopeFallback, sessionKey, conversationId)) {
    target = resolveOnlyScopedStopTarget(handler, address);
  }

  if (target) {
    if (eventBase.thread_ts) {
      await handler.handleStop(address, target, bot, eventBase.thread_ts);
    } else {
      await handler.handleStop(address, target, bot);
    }
  } else if (magicWord.addressed) {
    if (eventBase.thread_ts && bot.postInThread) {
      await bot.postInThread(conversationId, eventBase.thread_ts, formatNothingRunning(bot));
    } else {
      await bot.postMessage(conversationId, formatNothingRunning(bot));
    }
  }
}

function widensToScopedSession(
  scopeFallback: "top-level" | "always" | "never",
  sessionKey: string | undefined,
  conversationId: string,
): boolean {
  if (scopeFallback === "never") return false;
  if (scopeFallback === "always") return true;
  return sessionKey === undefined || sessionKey === conversationId;
}
