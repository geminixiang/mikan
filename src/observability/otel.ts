import { metrics } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SentryContextManager } from "@sentry/node";
import { SentryPropagator } from "@sentry/opentelemetry";
import { readStandardEnv } from "../env-manifest.js";
import { sanitizeTelemetryString } from "./sentry.js";

const SAFE_RESOURCE_KEYS = new Set([
  "deployment.environment.name",
  "openinference.project.name",
  "service.namespace",
  "service.version",
]);

let tracerProvider: NodeTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let metricsEnabled = false;

export interface OpenTelemetryConfiguration {
  traces: boolean;
  metrics: boolean;
}

export function resolveOpenTelemetryConfiguration(
  env: NodeJS.ProcessEnv = currentOpenTelemetryEnvironment(),
): OpenTelemetryConfiguration {
  if (env.OTEL_SDK_DISABLED?.toLowerCase() === "true") return { traces: false, metrics: false };

  return {
    traces:
      protocolSupported(
        env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL,
      ) &&
      exporterEnabled(env.OTEL_TRACES_EXPORTER) &&
      effectiveEndpointIsValid(
        env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
        env.OTEL_EXPORTER_OTLP_ENDPOINT,
      ),
    metrics:
      protocolSupported(
        env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL,
      ) &&
      exporterEnabled(env.OTEL_METRICS_EXPORTER) &&
      effectiveEndpointIsValid(
        env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
        env.OTEL_EXPORTER_OTLP_ENDPOINT,
      ),
  };
}

export function initializeOpenTelemetry(): boolean {
  const env = currentOpenTelemetryEnvironment();
  const configuration = resolveOpenTelemetryConfiguration(env);
  metricsEnabled = configuration.metrics;
  if (!configuration.traces && !configuration.metrics) return false;

  const resource = resourceFromAttributes(resolveOpenTelemetryResourceAttributes(env));

  if (configuration.metrics) {
    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: positiveInteger(env.OTEL_METRIC_EXPORT_INTERVAL),
          exportTimeoutMillis: positiveInteger(env.OTEL_METRIC_EXPORT_TIMEOUT),
        }),
      ],
    });
    metrics.setGlobalMeterProvider(meterProvider);
  }

  if (configuration.traces) {
    tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
    });
    tracerProvider.register({
      contextManager: new SentryContextManager(),
      propagator: new SentryPropagator(),
    });
  }

  return true;
}

export function isOpenTelemetryMetricsEnabled(): boolean {
  return metricsEnabled;
}

export async function shutdownOpenTelemetry(): Promise<void> {
  const providers = [tracerProvider, meterProvider].filter(
    (provider): provider is NodeTracerProvider | MeterProvider => provider !== undefined,
  );
  const flushResults = await Promise.allSettled(providers.map((provider) => provider.forceFlush()));
  const shutdownResults = await Promise.allSettled(
    providers.map((provider) => provider.shutdown()),
  );
  tracerProvider = undefined;
  meterProvider = undefined;
  metricsEnabled = false;

  const failures = [...flushResults, ...shutdownResults].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "OpenTelemetry shutdown failed");
  }
}

function exporterEnabled(value: string | undefined): boolean {
  if (!value) return true;
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .includes("otlp");
}

function protocolSupported(value: string | undefined): boolean {
  return !value || value.trim().toLowerCase() === "http/protobuf";
}

function effectiveEndpointIsValid(
  signalEndpoint: string | undefined,
  baseEndpoint: string | undefined,
): boolean {
  return validEndpoint(signalEndpoint ?? baseEndpoint);
}

function validEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const endpoint = new URL(value);
    return (
      (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
      endpoint.username === "" &&
      endpoint.password === ""
    );
  } catch {
    return false;
  }
}

export function resolveOpenTelemetryResourceAttributes(
  env: NodeJS.ProcessEnv = currentOpenTelemetryEnvironment(),
): Record<string, string> {
  const serviceName = safeResourceValue(env.OTEL_SERVICE_NAME) ?? "mikan";
  const attributes: Record<string, string> = { "service.name": serviceName };
  const parsed = parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
  if (!parsed) return attributes;

  for (const [key, value] of Object.entries(parsed)) {
    if (!SAFE_RESOURCE_KEYS.has(key)) continue;
    const safeValue = safeResourceValue(value);
    if (safeValue !== undefined) attributes[key] = safeValue;
  }
  return attributes;
}

function parseResourceAttributes(value: string | undefined): Record<string, string> | undefined {
  if (!value) return {};
  const attributes: Record<string, string> = {};
  try {
    for (const rawEntry of value.split(",").filter((entry) => entry.trim() !== "")) {
      const parts = rawEntry.split("=");
      if (parts.length !== 2) return undefined;
      const rawKey = parts[0]?.trim();
      const rawValue = parts[1]?.trim();
      if (!rawKey || rawValue === undefined) return undefined;
      const key = decodeURIComponent(rawKey);
      const decodedValue = decodeURIComponent(rawValue);
      if (key.length > 255 || decodedValue.length > 255) return undefined;
      attributes[key] = decodedValue;
    }
  } catch {
    return undefined;
  }
  return attributes;
}

function safeResourceValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 128) return undefined;
  if (
    [...trimmed].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return undefined;
  }
  return sanitizeTelemetryString(trimmed) === trimmed ? trimmed : undefined;
}

function currentOpenTelemetryEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "OTEL_SDK_DISABLED",
    "OTEL_SERVICE_NAME",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_TRACES_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
    "OTEL_METRIC_EXPORT_INTERVAL",
    "OTEL_METRIC_EXPORT_TIMEOUT",
  ] as const;
  return Object.fromEntries(names.map((name) => [name, readStandardEnv(name)]));
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
