import type { ConversationEvent } from "../adapter.js";
import { evaluateAutoReplyPolicy } from "../trigger.js";
import type { MessageIntakeOptions } from "./types.js";

/**
 * Shared message ingress pipeline for platform adapters.
 *
 * Platform adapters still normalize SDK events and handle platform-specific stop
 * semantics. This module owns the common trigger/log/attachment/queue/handler
 * ordering for messages that may start an agent run.
 */
export async function processMessageIntake<TEvent extends ConversationEvent>(
  options: MessageIntakeOptions<TEvent>,
): Promise<void> {
  const triggerResult = options.isAutoReplyCandidate
    ? await evaluateAutoReplyPolicy({ event: options.eventBase, workingDir: options.workingDir })
    : ({ trigger: true, reason: "addressed" } as const);

  if (!triggerResult.trigger) {
    options.log?.({ ...options.logEntryBase, attachments: [] });
    options.onNotTriggered?.();
    return;
  }

  function prepareEvent(attachments: unknown[]): TEvent {
    const event = { ...options.eventBase, attachments } as TEvent;
    options.log?.({ ...options.logEntryBase, attachments });
    return event;
  }

  function dispatch(event: TEvent): Promise<void> {
    const context = options.createContext(event);
    return options.handler.handleEvent(event, options.bot, context);
  }

  if (options.deferAttachmentsUntilRun) {
    options.enqueue(options.queueKey, async () => {
      const event = prepareEvent(await options.processAttachments());
      if (options.beforeEnqueue && !(await options.beforeEnqueue(event))) return;
      return dispatch(event);
    });
    return;
  }

  const event = prepareEvent(await options.processAttachments());
  if (options.beforeEnqueue && !(await options.beforeEnqueue(event))) return;
  options.enqueue(options.queueKey, () => dispatch(event));
}
