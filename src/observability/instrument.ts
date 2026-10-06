import * as Sentry from "@sentry/node";
import { readEnv } from "../env-manifest.js";
import { initializeOpenTelemetry, resolveOpenTelemetryConfiguration } from "./otel.js";
import { createSentryInitOptions } from "./sentry.js";

const sentryDsn = readEnv("SENTRY_DSN");
const otel = resolveOpenTelemetryConfiguration();
const customOpenTelemetry = otel.traces;
Sentry.init(createSentryInitOptions(sentryDsn, customOpenTelemetry));
initializeOpenTelemetry();
