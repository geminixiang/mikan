# src/observability

Vendor-neutral application observability with one OpenTelemetry trace and metric pipeline, optional OTLP/HTTP protobuf export, and a Sentry error-reporting adapter.

## Contracts

- `instrument.ts` is the startup side-effect entrypoint. `main.ts` imports it before application modules so providers exist before any tracer or meter is used.
- Application modules import the facade from `index.ts` and its payload types from `types.ts`; Sentry SDK types and calls stay behind the observability boundary.
- An OTLP pipeline is created only for explicitly configured endpoints, uses a minimal allowlisted Resource, and remains a no-op when unconfigured or disabled.
- mikan owns one trace provider and one metric provider. Sentry custom-OTel mode links issues to the active context without installing a second exporter, preventing duplicate application spans when Sentry and OTLP are both configured.
- Attributes and events are deliberately shaped and sanitized before they reach either backend. GenAI and OpenInference projections contain provider/model/operation, bounded attribution, counts, sizes, durations, token usage, cost, and status only—never prompts, completions, message text, tool arguments/results, file contents, credentials, tokens, or absolute paths.
- Platform conversation, session, message, thread, and user identifiers are exported as raw operational IDs so traces can be mapped directly back to the source conversation. Human-readable usernames, channel names, and workspace names remain excluded.
- Because direct Sentry OTLP ingestion drops span events, run-ending attributes summarize retry, compaction, budget, LLM, tool, attachment, and content-size counters on the root agent span.
- Shutdown happens after intake and accepted work drain: force-flush and shut down OpenTelemetry providers, then close Sentry. All providers are attempted even if one fails.
