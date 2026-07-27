import { join } from "path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 2_000;
// resolve from this file's location (e2e/slack/helpers/) up to repo root
const REPO_ROOT = join(import.meta.dirname, "../../..");

export interface SlackE2eEnv {
  token: string;
  channel: string;
  mikanBotUserId: string | undefined;
  streamingBotToken: string | undefined;
  timeoutMs: number;
  pollMs: number;
  eventsDir: string;
  workingDir: string;
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
    streamingBotToken: env.SLACK_BOT_TOKEN || undefined,
    timeoutMs: Number(env.SLACK_QA_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    pollMs: Number(env.SLACK_QA_POLL_MS ?? DEFAULT_POLL_MS),
    eventsDir: env.SLACK_QA_EVENTS_DIR ?? join(REPO_ROOT, ".workspace/mikan-workspace/events"),
    workingDir: env.SLACK_QA_WORKING_DIR ?? join(REPO_ROOT, ".workspace/mikan-workspace"),
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
      "SLACK_BOT_TOKEN must be a Slack Bot OAuth Token starting with xoxb- or xoxe-.",
    );
  }
}

export function hasBaseEnv(env: SlackE2eEnv): boolean {
  return Boolean(env.token && env.channel);
}
