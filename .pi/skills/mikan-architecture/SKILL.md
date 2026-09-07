---
name: mikan-architecture
description: Use when changing module boundaries or updating the architecture index and docs.
---

# Mikan Architecture

Choose the documentation level that owns the change:

- `architecture.toml` — shallow global topology, ownership, stable references.
- `ARCHITECTURE.md` — cross-module behavior and invariants.
- `src/*/README.md` — module-local interfaces and implementation.
- `docs/adr/` — consequential decisions and trade-offs.
- `CONTEXT.md` — domain vocabulary.

Verify architectural claims against relevant source and tests. Keep affected documents consistent without expanding the index into an inventory of private helpers or hypothetical modules.

When editing `architecture.toml`, load [references/SCHEMA.md](references/SCHEMA.md) for record and reference rules. Preserve IDs for continuous concepts; validate changed records, references, paths, and anchors. Use a TOML parser for syntax checks when TOML changes. Documentation-only edits do not require the code test suite.
