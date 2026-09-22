import * as Sentry from "@sentry/node";
import { resolveStateDir } from "../cli/arg-grammar.js";
import { resolveSentryDsn } from "../settings/index.js";
import { setEnvAliases } from "../env-manifest.js";
import { initializeOpenTelemetry, resolveOpenTelemetryConfiguration } from "./otel.js";
import { createSentryInitOptions } from "./sentry.js";

setEnvAliases("STATE_DIR", resolveStateDir());
const sentryDsn = resolveSentryDsn();
const otel = resolveOpenTelemetryConfiguration();
const customOpenTelemetry = otel.traces;
Sentry.init(createSentryInitOptions(sentryDsn, customOpenTelemetry));
initializeOpenTelemetry();
