# src/utils

Low-level utilities with no business logic.

## Files

- `date.ts`: Formats a Date as a local-timezone timestamp string (YYYY-MM-DD HH:MM:SS±HH:MM).
- `env.ts`: Reads environment variables with support for `MIKAN_`-prefixed aliases.
- `file-guards.ts`: Provides safe directory creation, text/JSON/schema reads, JSON parsing, and record type guards.
- `fs-atomic.ts`: Atomically writes sensitive files with private file permissions.
- `html.ts`: Escapes HTML special characters.
- `http-body.ts`: `readRawBody` — reads a size-limited HTTP request body, answering 413 and destroying the request when the limit is exceeded.
