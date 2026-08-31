# src/packages

Materializes package sources on the mikan host and resolves the skills they
contribute to a Conversation office.

A package is a git repository or host directory containing a `skills/`
directory. Packages are configured globally or per conversation, materialized
under the host-only state directory, and mounted read-only into Sandbox
runtimes. Package code is never imported into the mikan host process.

## Files

- `index.ts`: The module implementation in five sections.
  - **Grammar**: `parseSource` maps `<locator>[@<ref>][#<subpath>]` to a tagged
    `ParsedSource`; `sourceIdentity` defines package sameness; `formatSource`
    renders the canonical settings value.
  - **Materialization**: `materializeSource` clones or reconciles a source under
    the scope's `git/` directory. Its offline, fetch, and refresh modes control
    whether network access is allowed.
  - **Resolution**: `resolveConversationPackages` combines global and
    conversation scopes, applies scope precedence, and reports skill
    directories. `conversationPackageSkillMounts` converts the already-resolved
    package result into read-only Sandbox mounts; `packageSkillRuntimeDir` owns
    their guest paths.
  - **Inspection**: `inspectConversationPackages` reports each declared source,
    including materialization errors and scope shadowing, plus its skills.
  - **Admin**: `addPackage`, `removePackage`, and `refreshPackage` materialize
    before persisting settings, so failures return to the operator directly.
- `types.ts`: Package source, identity, materialization, resolution, inventory,
  and admin types.

Conversation-facing entry points take an `Office`, not a raw conversation ID.
`materializeSource` takes a scope plus an optional `OfficeAddress` because it
may run before an office is materialized.

## Scopes

Global packages apply to every conversation. Conversation packages are
additive, but a conversation declaration shadows the same global package.
Package identity ignores the ref, allowing one conversation to pin a different
version without loading both copies.

## Package layout

Skills live under `skills/<name>/SKILL.md`. A resolved package's `skills/`
directory is mounted read-only at `/mikan/packages/<slug>/skills`, outside
`/workspace`, so a writable workspace projection cannot shadow it. Supporting
files beside `SKILL.md` remain available to the skill.

Repositories without a `skills/` directory may still be materialized and
listed, but contribute no runtime capability.

## Refs and updates

`@<ref>` may name a tag, branch, or commit; absent means the remote default.
Materialized packages are never refreshed implicitly. Conversation resolution
uses offline mode, while Admin refresh is the explicit network operation.

Checkout paths are keyed by repository and effective ref. Subpaths at one ref
share a checkout; different refs cannot reset each other. The `mikan-ref`
marker is written only after checkout and subpath validation complete.

## Trust

Package files are untrusted content. They remain under the host-only state
directory and only declared skill directories cross into a Sandbox as
read-only mounts. mikan does not import or execute package modules in its host
process.
