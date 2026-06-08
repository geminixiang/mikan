const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 2_000;

export interface SlackE2eEnv {
  token: string;
  channel: string;
  mikanBotUserId: string | undefined;
  questionBotUserId: string | undefined;
  streamingBotToken: string | undefined;
  timeoutMs: number;
  pollMs: number;
  eventsDir: string;
  questionText: string;
  mikanText: string;
}

export function readSlackE2eEnv(): SlackE2eEnv {
  const env = process.env;
  const token = env.SLACK_QA_USER_TOKEN ?? "";
  const channel = env.SLACK_QA_CHANNEL_ID ?? "";
  return {
    token,
    channel,
    mikanBotUserId: env.SLACK_QA_BOT_USER_ID || undefined,
    questionBotUserId: env.SLACK_QA_QUESTION_BOT_USER_ID || undefined,
    streamingBotToken: env.SLACK_QA_STREAMING_BOT_TOKEN || env.SLACK_QA_BOT_TOKEN || undefined,
    timeoutMs: Number(env.SLACK_QA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    pollMs: Number(env.SLACK_QA_POLL_MS ?? DEFAULT_POLL_MS),
    eventsDir: env.SLACK_QA_EVENTS_DIR ?? `${process.cwd()}/events`,
    questionText: env.SLACK_QA_QUESTION_TEXT ?? "你是誰？請簡短回答。",
    mikanText: env.SLACK_QA_BOT_TEXT ?? "hello，請簡短回答。",
  };
}

export function assertTokenShape(token: string): void {
  if (!token.startsWith("xoxp-") && !token.startsWith("xoxe-")) {
    throw new Error(
      "SLACK_QA_USER_TOKEN must be a Slack User OAuth Token starting with xoxp- or xoxe-. Do not use xapp- or xoxb- tokens.",
    );
  }
}

export function assertBotTokenShape(token: string): void {
  if (!token.startsWith("xoxb-") && !token.startsWith("xoxe-")) {
    throw new Error(
      "SLACK_QA_STREAMING_BOT_TOKEN must be a Slack Bot OAuth Token starting with xoxb- or xoxe-.",
    );
  }
}

export function hasBaseEnv(env: SlackE2eEnv): boolean {
  return Boolean(env.token && env.channel);
}
