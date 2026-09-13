# src/observability

Vendor-neutral application observability with one OpenTelemetry trace and metric pipeline, optional OTLP/HTTP protobuf export, and a Sentry error-reporting adapter.

## Contracts

- `instrument.ts` is the startup side-effect entrypoint. `main.ts` imports it before application modules so providers exist before any tracer or meter is used.
- Application modules import only `index.ts`; Sentry SDK types and calls stay behind the observability boundary.
- An OTLP pipeline is created only for explicitly configured endpoints, uses a minimal allowlisted Resource, and remains a no-op when unconfigured or disabled.
- mikan owns one trace provider and one metric provider. Sentry custom-OTel mode links issues to the active context without installing a second exporter, preventing duplicate application spans when Sentry and OTLP are both configured.
- Attributes and events are deliberately shaped and sanitized before they reach either backend. GenAI and OpenInference projections contain provider/model/operation, bounded attribution, counts, sizes, durations, token usage, cost, and status only—never prompts, completions, message text, tool arguments/results, file contents, credentials, tokens, or absolute paths.
- Conversation, session, message, thread, and user identifiers are exported as stable opaque hashes. Set `TELEMETRY_HASH_KEY` to use deployment-specific HMAC identifiers; without it mikan uses a stable SHA-256 projection and still never exports the raw platform identifiers or usernames.
- Because direct Sentry OTLP ingestion drops span events, run-ending attributes summarize retry, compaction, budget, LLM, tool, attachment, and content-size counters on the root agent span.
- Shutdown happens after intake and accepted work drain: force-flush and shut down OpenTelemetry providers, then close Sentry. All providers are attempted even if one fails.

## Files

- `instrument.ts`: Resolves startup configuration, initializes Sentry in the appropriate interoperability mode, then registers the optional OpenTelemetry providers.
- `index.ts`: Vendor-neutral facade for errors, spans, metrics, lifecycle/diagnostic events, attribution, and shutdown.
- `otel.ts`: Standard OTLP/HTTP protobuf configuration, minimal Resource construction, provider/exporter ownership, and lifecycle.
- `sentry.ts`: Sentry-only adapter, issue policy, scope compatibility, defense-in-depth sanitization, and legacy Sentry metric fallback when OTLP metrics are not configured.
- `types.ts`: Internal observability payload and reporting shapes.
