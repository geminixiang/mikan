/**
 * Platform conversation history entry from log.jsonl.
 *
 * log.jsonl records what happened on the chat platform. sessions/*.jsonl are
 * LLM working contexts/records derived from platform messages and agent runs.
 */
export interface ConversationLogMessage {
  date?: string;
  ts?: string;
  threadTs?: string;
  user?: string;
  userName?: string;
  text?: string;
  isBot?: boolean;
}
