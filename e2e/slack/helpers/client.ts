import { WebClient } from "@slack/web-api";
import { assertTokenShape, hasBaseEnv, readSlackE2eEnv, type SlackE2eEnv } from "./env.js";

export interface SlackE2eContext {
  env: SlackE2eEnv;
  client: WebClient;
}

export function loadContextOrSkip(): SlackE2eContext | null {
  const env = readSlackE2eEnv();
  if (!hasBaseEnv(env)) return null;
  assertTokenShape(env.token);
  return { env, client: new WebClient(env.token) };
}
