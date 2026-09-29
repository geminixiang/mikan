# Pi telemetry adoption check — 2026-09

> Research date: 2026-09-27. First-party installed package source only.

Question: can mikan route Pi's internal telemetry into its existing OTLP
pipeline ([ADR 0007](../adr/0007-standard-otlp-observability.md)) and gain
visibility it does not have today?

Decision: **not yet**. Revisit when the trigger below fires.

## Packages involved

Both are upstream Pi dependencies that mikan already installs transitively
through `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`; adopting
them adds no direct dependency.

- `@earendil-works/chord` — `pi-agent-core` uses only its `Context` type,
  context helpers (`TODO_CONTEXT`, `withAbortSignal`, `withContextValue`, …),
  and JSON types. Every harness API takes a chord `Context` as its last
  argument; mikan passes `TODO_CONTEXT` everywhere
  (`src/harness/session.ts`, `src/sessions/session-store.ts`). Chord's
  services, facets, and replicated state serve a client/server architecture
  that mikan does not need.
- `@earendil-works/pi-telemetry` — a vendor-neutral `TelemetryContext` /
  `TelemetrySpan` contract (`startSpan`, `addEvent`, `setAttributes`,
  `setStatus`), a no-op default, an in-memory reference adapter, and an adapter
  conformance suite at `@earendil-works/pi-telemetry/testing`. `pi-agent-core`
  attaches it to a chord context with the public `withTelemetryContext()`.

## Finding: Pi emits almost none of its declared spans

`pi-agent-core` exports `HARNESS_TELEMETRY_SCHEMA` and `AI_TELEMETRY_SCHEMA`,
which declare twelve spans with content-free attributes (ids, names, counts,
error classes, time to first chunk, cache token usage). Only one is started
at runtime:

| Span                                           | Declared | Emitted in 0.87.0 / 0.87.1 |
| ---------------------------------------------- | -------- | -------------------------- |
| `pi.harness.hook`                              | yes      | yes (`harness/hooks.js`)   |
| `pi.harness.run`, `turn`, `step`, `tool`       | yes      | no                         |
| `pi.harness.compaction`, `checkpoint`, `sleep` | yes      | no                         |
| `pi.harness.navigation`, `event_handler`       | yes      | no                         |
| `pi.session.write`                             | yes      | no                         |
| `pi.ai.request`                                | yes      | no                         |

`pi-ai` forwards `telemetryContext` in its stream options, but no provider
starts a span with it.

A downstream fork on the same release line also emits only `pi.harness.hook`.
mikan's hooks are microsecond budget and loop-guard checks, so hook spans alone
carry no diagnostic value. mikan's `src/harness/presenter.ts` already records
the LLM and tool spans it needs, with `gen_ai.*` and OpenInference attributes.

Reproduce the check after a Pi upgrade:

```bash
grep -rn 'startHarnessSpan(\|startAiSpan(\|startSpan(' \
  node_modules/@earendil-works/pi-agent-core/dist \
  node_modules/@earendil-works/pi-ai/dist --include=*.js \
  | grep -v '\.map' | grep -v 'export function'
```

## Recheck on 0.99.1 (2026-09-30)

Still **not yet**. Pi 0.99.1 adds the telemetry types to the public
`pi-agent-core` exports, and the drive, compaction, and assistant execution
paths now forward the context's `telemetryContext` into `pi-ai` stream options.
The emitted spans are unchanged: the reproduction command above still finds
only `pi.harness.hook`, and no `pi-ai` provider starts `pi.ai.request`.
Upstream's own audit (`packages/agent/docs/post-wp05-roadmap.md`, "Telemetry
contract exceeds implementation") records the same gap and says Pi will first
decide whether each declared span is kept or removed from the public schema.
Adopting now would wire an adapter to a schema that may shrink.

## Trigger to revisit

Adopt when the Pi changelog or the check above shows `pi.ai.request` or
`pi.harness.tool` being started. Those spans would expose per-request latency,
retry waits, and compaction duration inside a run, which mikan currently sees
only as run-ending counters.

## Adoption plan (estimated half a day to one day)

1. Adapter in `src/observability/` mapping `TelemetryContext` to the mikan
   OpenTelemetry tracer, parented on the active run span, with an attribute
   allowlist so the ADR 0007 privacy contract holds. The declared Pi attributes
   are ids, names, counts, and error classes; the only high-cardinality values
   are session, operation, turn, and tool-call ids, which ADR 0007 already
   admits as operational ids.
2. Conformance test with `createTelemetryAdapterConformance`. It needs an
   in-memory span exporter from `@opentelemetry/sdk-trace-base`, currently only
   a transitive dependency of `sdk-trace-node`, so it requires approval as a
   direct devDependency.
3. Replace `TODO_CONTEXT` in the `lane.accept`, `lane.drive`, and
   `lane.compact` calls with `withTelemetryContext(adapter, context)`.
4. Document the exported `pi.*` attributes in `src/observability/README.md`.
