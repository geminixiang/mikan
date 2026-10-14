const CONTINUED_RUN_ID_PREFIX = "continue:";

export function continuedRunId(sessionKey: string): string {
  return `${CONTINUED_RUN_ID_PREFIX}${sessionKey}`;
}

export function isContinuedRunId(id: string): boolean {
  return id.startsWith(CONTINUED_RUN_ID_PREFIX);
}
