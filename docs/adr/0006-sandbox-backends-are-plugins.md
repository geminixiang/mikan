---
status: accepted
---

# mikan is a thin core on pi-agent-core with a plugin periphery

mikan's maintenance pain comes from mixing three layers: the client surface
(web portals, per-platform presentation), the engine (agent loop, session,
vault, workspace standing on `pi-agent-core` / `pi-ai`), and a middle glue
(office model, session JSONL, adapter plumbing) that is neither product
surface nor engine depth. The middle glue multiplies every change, and
client work outshines the engine, so the ceiling — harness agent quality —
does not move.

> Web-client composition and the removal of `web-bundle` are superseded by
> [ADR 0007](0007-full-harness-web-client.md). The thin-core/plugin criterion
> and sandbox decision in this ADR remain accepted.

The direction: mikan owns a **thin backend on pi** — session, vault,
workspace, and the agent-loop semantics pi does not cover — and delegates
the periphery (platform adapters, sandbox backends, tools, web UI) to
plugins, so the core stays focused and the periphery can be maintained by
colleagues or the open-source community. Sandbox backends are the first
pilot.

## What the core keeps

The core (`src/`) remains: `harness/` (agent loop semantics on pi), the
session store, `vault/`, the office/workspace model, `workspace-projection/`,
the command manifest, observability, the CLI grammar, and the web host seam.
These are the modules whose quality sets the system ceiling; they must not
special-case plugin internals.

Everything else is a candidate plugin: platform adapters, sandbox backends,
tool packs, web UI pages. A module earns a place in the core by being part of
the session/vault/workspace/agent-loop surface; anything else is a plugin
candidate until proven otherwise.

## The plugin contract (composition-time first)

A plugin is a package that declares capabilities and registers into a core
registry at boot. The monorepo already has the seam shape: `packages/*`
(workspace composition), the `web-host` route registry (registration +
single-seat fallback), and the `mikan ext` extension mechanism (runtime
installation from git). The contract formalizes these into one pattern:

- **Manifest**: a package declares its plugin kind(s) — e.g. a
  `mikan.plugins` field or an exported `register(core)` entry — so the core
  composes at boot without naming the plugin.
- **Registry**: the core exposes typed registries (`registerSandboxAdapter`,
  later `registerPlatformAdapter`, `registerToolPack`, …) with one home per
  contract in a shared contract package.
- **Core services**: plugins may declare which core services they need
  (provisioner, vault, identity, event store); the core injects them at
  registration, never via direct imports into `src/`.
- **Static first, dynamic later**: phase 1 composes workspace packages
  statically through workspace packages; phase 2 extends the existing
  `mikan ext` runtime loader to plugin kinds.

A contract is only frozen after at least two independent implementations
exist; a one-off abstraction is a draft, not an API.

## Sandbox pilot mechanics

`SandboxAdapter` (type / parse / validate / createExecutor / capabilities)
and the `src/sandbox` registry already exist; the obstacles are the closed
`SandboxConfig` union and the exhaustive switches in ~10 core files:

1. **Open the type**: `SandboxConfig` stays the closed union of the six
   built-in configs for settings/public-API compatibility, while the
   registry accepts adapters over `string` type names and treats plugin
   configs opaquely behind the adapter. Core never switches on a concrete
   type.
2. **Replace type switches with adapter-declared hooks/capabilities**:
   - `needsContainerProvisioner: boolean` replaces `type === "container"`
     (and the `image → container` resolution case).
   - `prepareBoot?(core): Promise<void>` replaces the gondolin/cloudflare
     boot special cases in `src/main.ts`.
   - path mapping stays on the executor (`getPathContext`), with the
     unresolved-`image` case folded into a declared capability.
   - credential/resource key derivation stays in `src/sandbox/identity.ts`
     (a core authority consumed by vault/execution-resolver); an adapter
     hook covers backends with non-default key needs.
3. **CLI grammar stays core**: `parseSandboxArg` remains the single parse
   authority, iterating the registered adapters' `parse()`.
4. **Migration order**: `host` (129 lines, no external deps — the seam
   proof) → `container`/`image` (exercises the provisioner service
   injection) → `firecracker` → `cloudflare` → `gondolin` (957 lines, last).
   Each step is one PR with the full gate green.

## Consequences

- A new sandbox backend becomes: a package implementing the contract plus
  one registration line — no core switch changes.
- The core loses exhaustive type-safety on plugin configs; the loss is
  contained to the adapter boundary (typed accessors, validation at
  registration).
- The plugin surface is a long-term commitment: semver + breaking policy +
  a `CONTRIBUTING` for plugin authors, shipped with the contract package.
- The middle glue shrinks as modules find a single home; core ownership
  narrows to session/vault/workspace/agent-loop, where mikan's ceiling is.
- Web product composition is governed by ADR 0007; `web-host` remains a
  generic route/fallback seam rather than a frontend plugin loader.

## Open questions

- Settings-schema extension (plugins declaring their own settings groups in
  the TypeBox schema) is deferred; sandbox type stays string-configured via
  `parseSandboxArg`.
- Public npm surface (`src/index.ts` exports `SandboxConfig`): the closed
  union stays exported; plugin configs get their own exported types in the
  contract package.
