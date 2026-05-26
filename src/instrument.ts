import * as Sentry from "@sentry/node";
import { resolveSentryDsn, resolveStateDirFromArgv } from "./config.js";
import { setEnvAliases } from "./env.js";
import { createSentryInitOptions } from "./sentry.js";

if (!process.env.STATE_DIR && !process.env.MIKAN_STATE_DIR) {
  setEnvAliases("STATE_DIR", resolveStateDirFromArgv());
}
const sentryDsn = resolveSentryDsn();

Sentry.init(createSentryInitOptions(sentryDsn));
