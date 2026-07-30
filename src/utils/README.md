# src/utils

Low-level utilities with no business logic.

## Files

- `file-guards.ts`: Provides safe directory creation, text/JSON/schema reads, JSON parsing, record type guards, and `atomicWritePrivateFile` (0600 temp-sibling + rename(2), so readers never see a torn write).
