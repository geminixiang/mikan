# OTLP observability, Sentry, and Arize Phoenix

> Research date: 2026-09-12. Primary documentation and first-party source only.

## OpenTelemetry Node SDK and OTLP configuration

- OpenTelemetry providers must be registered before application modules obtain and use instrumentation; otherwise API calls use no-op providers. mikan's first side-effect import in `main.ts` is therefore the correct bootstrap seam. Manual spans and metrics do not require ESM auto-instrumentation loader hooks. [Node SDK README/source](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/opentelemetry-sdk-node) [ESM support](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md)
- The standard OTLP base endpoint appends `/v1/traces` and `/v1/metrics`; per-signal endpoint variables are complete URLs and take precedence. Generic and per-signal headers, protocols, and timeouts follow the same precedence model. [OTLP exporter configuration](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/) [JavaScript exporters](https://opentelemetry.io/docs/languages/js/exporters/)
- A default Node SDK can select OTLP exporters even without an explicit endpoint and attempt localhost delivery. mikan deliberately gates provider creation on an explicit endpoint so its historical zero-configuration behavior remains network-free. The implementation supports only OTLP HTTP/protobuf and does not configure logs or automatic instrumentations. [Node SDK source](https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/opentelemetry-sdk-node/src/sdk.ts)
- A minimal manually constructed Resource avoids automatic host/process/command attributes. Only safe deployment/service/Phoenix project attributes should be admitted; credentials and paths must never be Resource attributes because they decorate every signal.

Versions checked in the registry: `@opentelemetry/api` 1.9.1, stable SDK packages 2.11.0, and experimental/exporter packages 0.222.0. mikan uses stable SDK 2.10.0 with exporter 0.221.0, the matching release line, while remaining within the OpenTelemetry API 1.9 compatibility range used by Sentry.

## Sentry interoperability

- `@sentry/node` uses OpenTelemetry internally. When the application owns the provider, Sentry requires `skipOpenTelemetrySetup: true`; ESM loader hooks should also be disabled to prevent duplicate hooks and spans. Correct scope/propagation uses Sentry's context manager and propagator. Omitting `SentrySpanProcessor` gives the documented error-only path instead of another Sentry span exporter. [Custom setup](https://docs.sentry.io/platforms/javascript/guides/node/opentelemetry/custom-setup/)
- Sentry also documents a lightweight OTLP bridge with `otlpIntegration({ setupOtlpTracesExporter: false })`. The false option links Sentry errors/logs to the active OTel trace without installing another exporter. [Lightweight SDK with OTLP](https://docs.sentry.io/platforms/javascript/guides/node/install/lightweight/#using-with-opentelemetry-otlp)
- First-party installed source confirms that the lightweight integration always registers active trace/span linking but creates a `BatchSpanProcessor` only when `setupOtlpTracesExporter` is true. Enabling that exporter in addition to mikan's exporter would double-export spans.
- Sentry direct OTLP ingestion is open beta, accepts traces and logs, and does not accept OTLP metrics. Direct trace export uses the standard per-signal endpoint and header variables. Span events are discarded and links/array attributes have limited search support. [Sentry OTLP](https://docs.sentry.io/concepts/otlp/) [Direct traces](https://docs.sentry.io/concepts/otlp/direct/traces/)

Design consequence: `SENTRY_DSN` enables Sentry issue reporting, not a second application trace/metric pipeline. An OpenTelemetry Collector should fan one stream out when the same spans must reach Sentry and Phoenix.

## Phoenix and OpenInference ingestion

- Self-hosted Phoenix accepts OTLP/HTTP traces at `http://<host>:6006/v1/traces` and OTLP/gRPC on port 4317. Its server registers the trace service and `/v1/traces` request type, not metrics or logs services. Phoenix derives token, cost, error, and latency views from trace attributes. [Phoenix exporter docs](https://arize.com/docs/phoenix/tracing/concepts-tracing/otel-openinference/exporter) [HTTP receiver source](https://github.com/Arize-ai/phoenix/blob/main/src/phoenix/server/api/routers/v1/traces.py) [gRPC server source](https://github.com/Arize-ai/phoenix/blob/main/src/phoenix/server/grpc_server.py)
- Phoenix project routing prefers the HTTP `x-project-name` header, then the portable `openinference.project.name` Resource attribute, then the default project. The Resource attribute works across transports. [Resource docs](https://arize.com/docs/phoenix/tracing/concepts-tracing/otel-openinference/resource) [Project setup](https://arize.com/docs/phoenix/tracing/how-to-tracing/setup-tracing/setup-projects)
- Current Phoenix ingestion converts standard `gen_ai.*` attributes to OpenInference fields and preserves existing OpenInference values. One span can therefore carry portable GenAI attributes plus a minimal content-free OpenInference projection for older Phoenix versions. [Conversion source](https://github.com/Arize-ai/phoenix/blob/main/src/phoenix/trace/gen_ai/conversion.py) [Ingestion hook](https://github.com/Arize-ai/phoenix/blob/main/src/phoenix/trace/otel.py)
- The Phoenix wrapper is unnecessary: its registration owns a global provider/lifecycle and adds OpenInference dependencies. A standard OTLP exporter plus manual attributes avoids a competing provider. [Phoenix OTEL package](https://github.com/Arize-ai/phoenix/blob/main/js/packages/phoenix-otel/package.json) [Registration source](https://github.com/Arize-ai/phoenix/blob/main/js/packages/phoenix-otel/src/register.ts)

## GenAI telemetry and privacy

- Current OpenTelemetry GenAI semantic conventions are in the dedicated repository and remain Development. Safe useful fields include operation, provider, request model, conversation identifier, input/output token counts, duration, and status. Agent invocation uses `invoke_agent`. [GenAI spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) [Agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) [Metrics](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md)
- Input/output messages, system instructions, prompt variables, tool definitions, tool arguments/results, and detailed content events are opt-in and may contain sensitive data. mikan must never construct them. It also must not record raw exceptions into OTLP spans because messages/stacks may expose content, credentials, or absolute paths. [GenAI content guidance](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md) [GenAI events](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md)
- OpenInference masking defaults do not protect arbitrary application attributes. Privacy must be enforced before recording, not delegated to a backend wrapper. [Trace configuration source](https://github.com/Arize-ai/openinference/blob/main/js/packages/openinference-core/src/trace/trace-config/constants.ts) [Masking source](https://github.com/Arize-ai/openinference/blob/main/js/packages/openinference-core/src/trace/trace-config/maskingRules.ts)

## Selected constraints

1. One application-owned provider/export lifecycle; no LLM or Node auto-instrumentation.
2. OTLP over HTTP/protobuf for traces and metrics; no logs or gRPC dependencies.
3. Explicit endpoint gating preserves no-config/no-network behavior.
4. Sentry remains the sanitized issue backend and does not install a duplicate span exporter.
5. Phoenix receives content-free standard GenAI and minimal OpenInference attributes on the same spans.
6. Shutdown drains application work, force-flushes/shuts down OpenTelemetry, then closes Sentry; every backend is attempted.
