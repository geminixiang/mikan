---
name: mikan-architecture
description: Maintains mikan's global architecture index and system architecture documentation. Use when adding, removing, splitting, or merging modules; changing seams, resource authority, major flows, cross-module invariants, trust boundaries, or known deviations; or when reviewing architecture.toml and ARCHITECTURE.md for consistency.
---

# Mikan Architecture

Maintain mikan's architecture as a layered documentation system:

1. `architecture.toml` is the canonical, shallow global index.
2. `ARCHITECTURE.md` explains cross-module behavior and invariants.
3. `src/*/README.md` explains module-local interfaces and implementation.
4. `docs/adr/*.md` records consequential design decisions and trade-offs.
5. Source and tests provide implementation evidence.

Read [references/SCHEMA.md](references/SCHEMA.md) before editing `architecture.toml`. It is the normative schema for `schema_version = "1.0"`.

## Workflow

1. Read `CONTEXT.md` for domain language.
2. Read `architecture.toml` to locate affected global records.
3. Read the linked section in `ARCHITECTURE.md` and the affected module README files completely.
4. Inspect implementation and tests before changing an architecture claim.
5. Decide the correct documentation level:
   - Change `architecture.toml` for global topology, ownership, or stable cross-module references.
   - Change `ARCHITECTURE.md` for system-level semantics, ordering, trust, failure behavior, invariants, or deviations.
   - Change a module README when behavior remains behind an existing seam.
   - Add an ADR only when a decision is difficult to reverse, surprising without context, and chosen from real alternatives.
6. Keep TOML records shallow. Move algorithms, rationale, detailed error modes, and long prose to Markdown.
7. Validate the schema and every referenced path or ID.

## Architecture classification test

Add a module only when it earns a global identity through at least one of:

- **Slot**: it fills an established adapter or backend axis.
- **Authority**: it is the single home of a cross-module rule or resource convention.
- **Weight**: it owns knowledge readers must understand together.

Do not add private helpers, local types, exhaustive exports, or hypothetical seams.

Add a seam only when callers depend on a stable relationship. A TypeScript `interface` alone is not sufficient.

Add a resource only when its ownership, scope, or security classification matters across modules.

Add a flow only for a high-value cross-module path. Its `path` shows topology, not a function-level trace.

Add an invariant only when several modules must preserve the same identity, ordering, security, persistence, lifecycle, or compatibility property.

Add a deviation when current behavior or support differs from the accepted model. Do not silently rewrite the accepted model to match a transitional implementation.

## Stability rules

- IDs are lowercase kebab-case and stable across source refactors and display-name changes.
- Never reuse a removed ID for a different concept.
- Preserve an ID when the architecture concept remains continuous.
- A module owns each seam and resource through exactly one `owner` or `authority` reference.
- All cross-record references must resolve according to the typed-reference rules in the schema.
- Every `docs`, `adr`, and `sources` path must exist.
- Every `ARCHITECTURE.md#...` reference must resolve to a heading or explicit HTML anchor.
- Keep `architecture.toml` and `ARCHITECTURE.md` synchronized in the same change.
- Increment `schema_version` only according to the schema evolution rules.

## Required verification

After an architecture change:

1. Parse `architecture.toml` with a standards-compliant TOML 1.0 parser.
2. Check required and unknown fields against [references/SCHEMA.md](references/SCHEMA.md).
3. Check uniqueness and typed references.
4. Check referenced paths and Markdown anchors.
5. Run:

```bash
npx oxfmt -c .config/oxfmtrc.json --check \
  ARCHITECTURE.md architecture.toml \
  .pi/skills/mikan-architecture/SKILL.md \
  .pi/skills/mikan-architecture/references/SCHEMA.md

git diff --check
```

Documentation-only architecture changes do not require the code test suite unless they alter or assert behavior that needs targeted verification.
