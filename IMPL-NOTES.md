# IMPL-A design notes (capability contract + golden path)

## Capability granularity

Eleven names mirroring `ExtensionHostServices` fields, with dotted grouping
(`messaging.*`, `schedules.*`) but no wildcard semantics — `messaging` is
`postMessage` alone, not a bundle. Rationale: the services interface is
already the honest inventory of what a context can provide; inventing a
coarser vocabulary on top would add a second mapping to maintain. `blockkit`
is the one composite (post + update) because the two are useless apart.

## Single authority

`CAPABILITY_PROBES` in loader.ts is the one table mapping capability name →
service probe. The pre-activation check, `api.capabilities`, and validate's
unknown-name warning all derive from it. `isExtensionCapability` stays
module-private.

## Unknown names

- `mikan ext validate`: **warn** — the name may exist in a newer mikan;
  validation runs on dev machines where blocking is unhelpful.
- Activation: **fail** — an unknown requirement can never be satisfied here,
  and silently ignoring it would defeat the declaration's purpose. The error
  names both unmet and unknown entries in one message.

## Manifest shape

`manifest.requires` keeps raw strings (not the union type) so unknown names
survive parsing for validate to report; classification happens at the two
consumers. `mikan.requires` rides package.json next to `mikan.secrets`,
following the existing declaration pattern (required secrets are also
checked pre-import).

## Check placement

Before `importExtensionModule`, after the secrets check — same design as
secrets: one clear provisioning/configuration error beats whatever the
module would throw at first api call, and top-level module code never runs
in a context that cannot host the extension (verified by test: probe file
not written).

## ext init

Scaffolds package.json + index.ts inline from `scaffoldFiles()` in ext.ts —
no template directory to ship or resolve at runtime. The scaffold is the
golden-path shape (command + callback schedule + state) with type-only
mikan import so it runs unbuilt under `ext dev`. Name gate `[a-z0-9][a-z0-9_-]*`
matches slug sanitization so the directory name IS the slug.

## Not done (deliberately)

- Activation/rollout semantics unchanged (ADR 0006 defers to a later stage).
- No `api.state` primitive (deferred item 2).
- agent-pm not migrated to declare requires — riding demand: next touch.
