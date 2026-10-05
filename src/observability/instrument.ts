import * as Sentry from "@sentry/node";
import { stateDirPath } from "../cli/arg-grammar.js";
import { resolveSentryDsn } from "../settings/index.js";
import { initializeOpenTelemetry, resolveOpenTelemetryConfiguration } from "./otel.js";
import { createSentryInitOptions } from "./sentry.js";

const sentryDsn = resolveSentryDsn(stateDirPath());
const otel = resolveOpenTelemetryConfiguration();
const customOpenTelemetry = otel.traces;
Sentry.init(createSentryInitOptions(sentryDsn, customOpenTelemetry));
initializeOpenTelemetry();
