# src/observability

Sentry error reporting and startup instrumentation.

## Files

- `sentry.ts`: Provides Sentry initialization options, reporting helpers, metric attributes, lifecycle breadcrumbs, and sensitive-data sanitization.
- `instrument.ts`: Initializes state-dir environment aliases and Sentry early during startup (side-effect import).
