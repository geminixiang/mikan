# src/observability

Sentry error reporting and startup instrumentation.

## Files

- `instrument.ts`: Initializes state-dir environment aliases and Sentry early during startup (side-effect import).
- `sentry.ts`: Provides Sentry initialization options, reporting helpers, metric attributes, lifecycle breadcrumbs, and sensitive-data sanitization.
- `types.ts`: The run-scope, span, transaction, and user-facing-error payload shapes `sentry.ts` reports.
