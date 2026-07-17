import * as Sentry from "@sentry/node";
import { resolveStateDir } from "../cli/arg-grammar.js";
import { resolveSentryDsn } from "../config.js";
import { setEnvAliases } from "../utils/env.js";
import { createSentryInitOptions } from "./sentry.js";

// Populate the STATE_DIR compat channel before Sentry reads settings.json.
// resolveStateDir applies the declared precedence (flag > env > default), so
// a --state-dir flag wins here exactly as it does in the boot plan.
setEnvAliases("STATE_DIR", resolveStateDir());
const sentryDsn = resolveSentryDsn();

Sentry.init(createSentryInitOptions(sentryDsn));
