import type { BotEvent } from "../adapter.js";
import { evaluateAutoReplyPolicy } from "../trigger.js";
import type { MessageIntakeOptions } from "./types.js";

/**
 * Shared message ingress pipeline for platform adapters.
 *
 * Platform adapters still normalize SDK events and handle platform-specific stop
 * semantics. This module owns the common trigger/log/attachment/queue/handler
 * ordering for messages that may start an agent run.
 */
export async function processMessageIntake<TEvent extends BotEvent>(
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

  if (options.deferAttachmentsUntilRun) {
    options.enqueue(options.queueKey, async () => {
      const attachments = await options.processAttachments();
      const event = { ...options.eventBase, attachments } as TEvent;
      options.log?.({ ...options.logEntryBase, attachments });
      if (options.beforeEnqueue && !(await options.beforeEnqueue(event))) {
        return;
      }
      const adapters = options.createAdapters(event);
      return options.handler.handleEvent(event, options.bot, adapters);
    });
    return;
  }

  const attachments = await options.processAttachments();
  const event = { ...options.eventBase, attachments } as TEvent;
  options.log?.({ ...options.logEntryBase, attachments });

  if (options.beforeEnqueue && !(await options.beforeEnqueue(event))) {
    return;
  }

  options.enqueue(options.queueKey, () => {
    const adapters = options.createAdapters(event);
    return options.handler.handleEvent(event, options.bot, adapters);
  });
}
