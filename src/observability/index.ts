import { metrics, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";
import {
  addSentryBreadcrumb,
  captureSentryError,
  closeSentry,
  createRunScopeAttributes,
  recordSentryCounter,
  recordSentryDistribution,
  recordSentryGauge,
  sanitizeValue,
  withSentryRunScope,
} from "./sentry.js";
import { isOpenTelemetryMetricsEnabled, shutdownOpenTelemetry } from "./otel.js";
import type {
  DiagnosticBreadcrumb,
  JevOutcomeReport,
  ObservabilityAttributes,
  ReportUserFacingErrorOptions,
  RunScopeContext,
} from "./types.js";

export interface ObservabilitySpan {
  end(options?: { attributes?: ObservabilityAttributes; error?: unknown }): void;
}

const tracer = trace.getTracer("@geminixiang/mikan");
const meter = metrics.getMeter("@geminixiang/mikan");
const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
const histograms = new Map<string, ReturnType<typeof meter.createHistogram>>();
const gauges = new Map<string, ReturnType<typeof meter.createGauge>>();

export function metricAttributes(
  attributes: Record<string, string | number | boolean | undefined>,
): ObservabilityAttributes {
  return Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) => {
      if (value === undefined) return [];
      const sanitized = sanitizeValue(value, key);
      return typeof sanitized === "string" ||
        typeof sanitized === "number" ||
        typeof sanitized === "boolean"
        ? [[key, sanitized] as const]
        : [];
    }),
  );
}

export function recordCounter(
  name: string,
  value: number,
  attributes: ObservabilityAttributes = {},
): void {
  const safeAttributes = metricAttributes(attributes);
  if (!isOpenTelemetryMetricsEnabled()) {
    recordSentryCounter(name, value, safeAttributes);
    return;
  }
  let counter = counters.get(name);
  if (!counter) {
    counter = meter.createCounter(name);
    counters.set(name, counter);
  }
  counter.add(value, safeAttributes as Attributes);
}

export function recordDistribution(
  name: string,
  value: number,
  options: { unit?: string; attributes?: ObservabilityAttributes } = {},
): void {
  const safeAttributes = metricAttributes(options.attributes ?? {});
  if (!isOpenTelemetryMetricsEnabled()) {
    recordSentryDistribution(name, value, {
      unit: options.unit ? options.unit : undefined,
      attributes: safeAttributes,
    });
    return;
  }
  const key = `${name}\0${options.unit ?? ""}`;
  let histogram = histograms.get(key);
  if (!histogram) {
    histogram = meter.createHistogram(name, options.unit ? { unit: options.unit } : undefined);
    histograms.set(key, histogram);
  }
  histogram.record(value, safeAttributes as Attributes);
}

export function recordGauge(
  name: string,
  value: number,
  options: { unit?: string; attributes?: ObservabilityAttributes } = {},
): void {
  const safeAttributes = metricAttributes(options.attributes ?? {});
  if (!isOpenTelemetryMetricsEnabled()) {
    recordSentryGauge(name, value, {
      unit: options.unit ? options.unit : undefined,
      attributes: safeAttributes,
    });
    return;
  }
  const key = `${name}\0${options.unit ?? ""}`;
  let gauge = gauges.get(key);
  if (!gauge) {
    gauge = meter.createGauge(name, options.unit ? { unit: options.unit } : undefined);
    gauges.set(key, gauge);
  }
  gauge.record(value, safeAttributes as Attributes);
}

export function createRunAttributionAttributes(context: RunScopeContext): ObservabilityAttributes {
  return metricAttributes({
    ...createRunScopeAttributes(context),
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": "mikan",
    "gen_ai.conversation.id": context.sessionKey,
    "openinference.span.kind": "AGENT",
    "session.id": context.sessionKey,
  });
}

export async function withRunSpan<T>(context: RunScopeContext, body: () => Promise<T>): Promise<T> {
  const attribution = createRunAttributionAttributes(context);
  return tracer.startActiveSpan("agent.run", { attributes: attribution as Attributes }, (span) =>
    withSentryRunScope(context, async () => {
      try {
        return await body();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorType(error) });
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}

export function startOperationSpan(
  name: string,
  attributes: ObservabilityAttributes = {},
): ObservabilitySpan {
  const span = tracer.startSpan(name, {
    attributes: metricAttributes(attributes) as Attributes,
  });
  return {
    end(options = {}) {
      if (options.attributes) {
        span.setAttributes(metricAttributes(options.attributes) as Attributes);
      }
      if (options.error !== undefined) {
        const errorType = safeErrorType(options.error);
        span.setAttribute("error.type", errorType);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorType });
      }
      span.end();
    },
  };
}

export function updateActiveSpanAttribution(attributes: ObservabilityAttributes): void {
  trace.getActiveSpan()?.setAttributes(metricAttributes(attributes) as Attributes);
}

export function addLifecycleEvent(
  name: string,
  attributes?: Record<string, string | number | boolean | undefined>,
): void {
  const safeAttributes = attributes ? metricAttributes(attributes) : undefined;
  trace.getActiveSpan()?.addEvent(name, safeAttributes as Attributes | undefined);
  addSentryBreadcrumb(name, safeAttributes);
}

export function recordDiagnosticEvent(
  name: string,
  data: Record<string, unknown>,
  breadcrumb: DiagnosticBreadcrumb,
): void {
  const spanAttributes = metricAttributes(
    Object.fromEntries(
      Object.entries(data).filter((entry): entry is [string, string | number | boolean] => {
        const value = entry[1];
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      }),
    ),
  );
  trace.getActiveSpan()?.addEvent(name, spanAttributes as Attributes);
  addSentryBreadcrumb(breadcrumb.message, data, breadcrumb);
}

export function reportUserFacingError(
  error: unknown,
  options: ReportUserFacingErrorOptions,
): string | undefined {
  if (options.expected) return undefined;
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute("error.type", safeErrorType(error));
    span.setStatus({ code: SpanStatusCode.ERROR, message: safeErrorType(error) });
  }
  return captureSentryError(error, options);
}

export function captureError(error: unknown): string | undefined {
  return reportUserFacingError(error, {
    domain: "mikan",
    surface: "process",
    operation: "shutdown",
    severity: "error",
  });
}

export async function shutdownObservability(timeoutMs: number): Promise<boolean> {
  let openTelemetryFailure: unknown;
  try {
    await shutdownOpenTelemetry();
  } catch (error) {
    openTelemetryFailure = error;
  }

  let sentryClosed: boolean;
  try {
    sentryClosed = await closeSentry(timeoutMs);
  } catch (error) {
    if (openTelemetryFailure !== undefined) {
      const failure = new Error("Observability shutdown failed", { cause: error });
      Object.assign(failure, { errors: [openTelemetryFailure, error] });
      throw failure;
    }
    throw new Error("Sentry shutdown failed", { cause: error });
  }

  if (openTelemetryFailure !== undefined) throw openTelemetryFailure;
  return sentryClosed;
}

function safeErrorType(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name))
    return error.name;
  return "Error";
}

export function recordJevOutcome(report: JevOutcomeReport): void {
  const attributes = metricAttributes({ caller: report.caller, status: report.status });
  recordCounter("agent.jev.calls", 1, attributes);
  if (report.costUsd !== undefined) {
    recordDistribution("agent.jev.cost", report.costUsd, { attributes });
  }
  if (report.durationMs !== undefined) {
    recordDistribution("agent.jev.duration", report.durationMs, {
      unit: "millisecond",
      attributes,
    });
  }
  addLifecycleEvent("agent.jev.completed", {
    caller: report.caller,
    status: report.status,
    error_type: report.errorType,
    input_tokens: report.inputTokens,
    output_tokens: report.outputTokens,
    cost_usd: report.costUsd,
    duration_ms: report.durationMs,
  });
}
