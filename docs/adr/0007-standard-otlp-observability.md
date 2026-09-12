# ADR 0007: Standard OTLP observability

- Status: Accepted
- Date: 2026-09-12

## Context

mikan's application telemetry was coupled directly to the Sentry Node SDK. Sentry supplied issue reporting, traces, metrics, run scope, and shutdown, but application imports and Sentry-specific span types made another backend difficult to support. The required backends have different signal support: Sentry can receive issues and OTLP traces/logs but not OTLP metrics, while Arize Phoenix accepts OTLP traces and derives its GenAI views from span attributes.

Observability also has a strict privacy contract. Prompts, completions, message text, tool arguments/results, file contents, credentials, tokens, and absolute paths must not reach a telemetry backend. Automatic LLM, HTTP, resource, or process instrumentation could violate that contract or create duplicate spans.

## Decision

mikan owns one manually instrumented OpenTelemetry trace pipeline and one metric pipeline. Application modules use the vendor-neutral `src/observability/index.ts` facade; Sentry imports remain inside the observability module.

The supported export protocol is OTLP over HTTP/protobuf. Providers are registered only when an explicit base or per-signal OTLP endpoint is configured, the signal exporter is not disabled, the configured protocol is supported, and `OTEL_SDK_DISABLED` is not true. With no configuration, observability remains a no-op and performs no OTLP network activity.

Sentry remains an optional issue backend. When mikan owns the trace provider, Sentry uses its documented custom-OpenTelemetry interoperability mode and does not install another span exporter or ESM loader hook. This links captured issues to the active context without exporting the application span tree twice. A Collector is the supported way to fan one OTLP stream out to Phoenix and Sentry.

Instrumentation is manual and content-free. The same span may carry safe standard `gen_ai.*` attributes and a minimal OpenInference projection for Phoenix compatibility; this is one span with two semantic projections, not duplicate tracing. Resource attributes are allowlisted. Raw exceptions are not recorded into OTLP spans; spans receive only a bounded error type and error status, while the Sentry adapter retains its sanitized issue behavior.

Shutdown ordering is application work drain, OpenTelemetry force-flush and provider shutdown, then Sentry close. Every configured backend is attempted even if another fails.

## Consequences

- Standard OTLP collectors and trace backends can receive mikan telemetry without application-level vendor coupling.
- Phoenix is supported as a trace destination; its server is not documented as a metrics destination.
- Sentry issue behavior remains available, but `SENTRY_DSN` does not implicitly create a second OTLP trace or metric exporter.
- The implementation adds only the OpenTelemetry API, trace/metric SDKs, HTTP/protobuf exporters, Resource package, and Sentry interoperability package. It does not add Phoenix SDKs, OpenInference auto-instrumentation, logs export, gRPC export, or Node auto-instrumentation.
- Operators needing multiple destinations must use a Collector rather than configuring duplicate in-process providers.
- GenAI semantic conventions remain under development, so their attribute names are internal compatibility details rather than a public API.

## Sources

See [`docs/research/otlp-observability-2026-09-12.md`](../research/otlp-observability-2026-09-12.md) for the primary-source findings behind this decision.
