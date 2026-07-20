import {
  assertSessionKeyBelongsToConversation,
  assertConversationId,
  deriveSessionKey,
  scopeSessionIdentity,
} from "../sessions/session-key.js";
import type { ConversationEvent } from "../adapter.js";
import type { ResolvedConversationStorage } from "../sessions/types.js";
import { formatAlreadyWorking, formatNothingRunning } from "../platform-messages.js";
import { evaluateAutoReplyPolicy } from "../trigger.js";
import { resolveOnlyScopedStopTarget, resolveStopTarget } from "./shared.js";
import type { MessageIntakeOptions, MessageIntakeOutcome } from "./types.js";

/**
 * Recognize a magic word: a highest-priority chat control phrase that bypasses
 * trigger policy and queueing (see CONTEXT.md). One grammar for every
 * platform: optional leading slash, optional `@botname` suffix, any case.
 */
export function matchMagicWord(text: string): "stop" | null {
  return /^\/?stop(?:@\w+)?$/i.test(text.trim()) ? "stop" : null;
}

/**
 * Shared message ingress pipeline for platform adapters.
 *
 * Platform adapters normalize SDK events; this module owns the ordering for
 * messages that may start an agent run:
 *
 *   magic word → trigger policy → attachments → log → busy policy → queue → dispatch
 *
 * Magic words are matched before the trigger gate — `stop` must never wait on
 * an auto-reply judgment or queue behind a running agent turn. Adapters state
 * platform policy as data (`magicWord`, `busyPolicy`) instead of callbacks.
 */
export async function processMessageIntake<TEvent extends ConversationEvent>(
  options: MessageIntakeOptions<TEvent>,
): Promise<MessageIntakeOutcome> {
  const conversationId = assertConversationId(options.eventBase.conversationId);
  if (options.eventBase.sessionKey !== undefined) {
    assertSessionKeyBelongsToConversation(options.eventBase.sessionKey, conversationId);
  }
  assertSessionKeyBelongsToConversation(options.queueKey, conversationId);

  const storage = options.resolveStorage ? await options.resolveStorage() : undefined;
  const platformSessionKey = deriveSessionKey(options.eventBase);
  const runtimeSessionKey = storage
    ? scopeSessionIdentity(platformSessionKey, conversationId, storage.storageKey).runtimeSessionKey
    : platformSessionKey;
  const runtimeQueueKey = storage
    ? scopeSessionIdentity(options.queueKey, conversationId, storage.storageKey).runtimeSessionKey
    : options.queueKey;
  const eventBase = {
    ...options.eventBase,
    ...(storage
      ? {
          storageKey: storage.storageKey,
          conversationDir: storage.conversationDir,
          runtimeSessionKey,
        }
      : {}),
  } as TEvent;

  function logEntry(entry: Record<string, unknown>): void {
    if (storage) options.log?.(entry, storage);
    else options.log?.(entry);
  }

  if (matchMagicWord(options.magicWord.text ?? eventBase.text) === "stop") {
    logEntry({ ...options.logEntryBase, attachments: [] });
    await handleStopMagicWord(options, runtimeSessionKey, platformSessionKey, storage);
    return "magic-word";
  }

  const triggerResult = options.isAutoReplyCandidate
    ? await evaluateAutoReplyPolicy({
        event: eventBase,
        workingDir: options.workingDir,
        conversationDir: storage?.conversationDir,
      })
    : ({ trigger: true, reason: "addressed" } as const);

  if (!triggerResult.trigger) {
    logEntry({ ...options.logEntryBase, attachments: [] });
    return "not-triggered";
  }

  function prepareEvent(attachments: unknown[]): TEvent {
    const event = { ...eventBase, attachments } as TEvent;
    logEntry({ ...options.logEntryBase, attachments });
    return event;
  }

  async function rejectedWhileBusy(): Promise<boolean> {
    if (!options.handler.isRunning(runtimeSessionKey)) return false;
    await options.bot.postMessage(conversationId, formatAlreadyWorking(options.bot, "/stop"));
    return true;
  }

  function dispatch(event: TEvent): Promise<void> {
    const context = options.createContext(event);
    return options.handler.handleEvent(event, options.bot, context);
  }

  if (options.deferAttachmentsUntilRun) {
    // Busy rejection happens inside the queued work here, so the outcome is
    // already "enqueued" by the time it is evaluated.
    options.enqueue(runtimeQueueKey, async () => {
      const event = prepareEvent(await options.processAttachments(storage));
      if (options.busyPolicy === "reject" && (await rejectedWhileBusy())) return;
      return dispatch(event);
    });
    return "enqueued";
  }

  const event = prepareEvent(await options.processAttachments(storage));
  if (options.busyPolicy === "reject" && (await rejectedWhileBusy())) return "rejected-busy";
  options.enqueue(runtimeQueueKey, () => dispatch(event));
  return "enqueued";
}

/**
 * Resolve and stop the session a magic-word `stop` targets. When nothing is
 * running, reply only if the message addressed the bot — an unaddressed
 * "stop" in a busy channel should never make the bot pipe up.
 */
async function handleStopMagicWord<TEvent extends ConversationEvent>(
  options: MessageIntakeOptions<TEvent>,
  runtimeSessionKey: string,
  platformSessionKey: string,
  storage?: ResolvedConversationStorage,
): Promise<void> {
  const { handler, bot, eventBase, magicWord } = options;
  const conversationId = eventBase.conversationId;
  const runtimeConversationId = conversationIdOfRuntimeKey(runtimeSessionKey);

  let target = resolveStopTarget({
    handler,
    conversationId: runtimeConversationId,
    sessionKey: runtimeSessionKey,
  });
  if (
    !target &&
    widensToScopedSession(magicWord.scopeFallback, eventBase.sessionKey, conversationId)
  ) {
    target = resolveOnlyScopedStopTarget(handler, runtimeConversationId);
  }

  if (target) {
    if (storage) {
      await handler.handleStop(target, conversationId, bot, {
        platformSessionKey,
        storageKey: storage.storageKey,
        conversationDir: storage.conversationDir,
      });
    } else {
      await handler.handleStop(target, conversationId, bot);
    }
  } else if (magicWord.addressed) {
    await bot.postMessage(conversationId, formatNothingRunning(bot));
  }
}

function conversationIdOfRuntimeKey(runtimeSessionKey: string): string {
  const separator = runtimeSessionKey.indexOf(":");
  return separator === -1 ? runtimeSessionKey : runtimeSessionKey.slice(0, separator);
}

function widensToScopedSession(
  scopeFallback: "top-level" | "always" | "never",
  sessionKey: string | undefined,
  conversationId: string,
): boolean {
  if (scopeFallback === "never") return false;
  if (scopeFallback === "always") return true;
  // "top-level": only a message aimed at the persistent conversation session
  // may widen to the single running scoped session; thread messages stay put.
  return sessionKey === undefined || sessionKey === conversationId;
}
