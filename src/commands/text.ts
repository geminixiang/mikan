/**
 * Chat-command text recognition, owned by the commands module so the
 * inventory lives beside the handlers it mirrors. Session resume uses it to
 * keep command messages out of replayed history.
 */
export function isCommandText(text: string): boolean {
  return /^\/(?:pi-[\w-]+|login|session|new|stop|model|sandbox|admin|auto-reply)(?:@\w+)?(?:\s|$)/i.test(
    text.trim(),
  );
}
