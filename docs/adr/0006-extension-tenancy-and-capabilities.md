---
status: proposed
---

# Extension tenancy: actors, scopes, and the capability contract

mikan's extension system was shaped after pi-coding-agent's, whose trust
model is "user = owner = fully trusted". mikan is multi-tenant: the person
who installs extension code, the person who owns the conversation it runs
in, and the person who wrote it are three different actors. This ADR names
that model so every future extension/vault/sandbox decision derives from it
instead of being re-litigated. Full analysis:
`docs/research/design-review-2026-08/extension-tenancy-review.md` and
`extension-devx-review.md`.

## Why extensions exist: the pressure-release valve

The agent's behavior is deliberately confined: bash/edit/write run inside
the sandbox, and what the model can reach is what the office grants it.
That confinement creates pressure — users have legitimate needs the agent's
tools don't cover — and when there is no sanctioned outlet, users drill
through the wall. The motivating real case: a user who wanted the agent to
post Slack replies put a raw Slack API key into the conversation vault so
bash could curl the Slack API. That "works", and it is exactly the failure
mode this system exists to prevent:

- the credential enters the sandbox, inside the model's reach — one prompt
  injection away from exfiltration or misuse;
- the model composes the API calls, so what gets posted is
  model-generated, unaudited, and outside mikan's platform semantics
  (threading, attribution, history sync all bypassed);
- the deployment's security posture now depends on a workaround no one
  reviewed.

Extensions are the official pressure-release valve. An extension holds what
the model must never touch (credentials, platform APIs) in host code, and
exposes only a semantic surface (`api.notify`, `api.blockkit`, a custom
tool). The model can request the effect; it can never hold the means. The
capability inventory doubles as the catalog of sanctioned outlets: when a
need isn't covered, that is a signal to add a capability — not a license to
put a key where the model can reach it. The review heuristic is one
question: _does this change let the model hold a raw credential or an
unmediated external surface?_ If yes, the answer is an extension.

This is also why extension code runs on the host and not in the sandbox:
moving it inside would put the very things it exists to guard back into the
model's reach, defeating its purpose.

## Actors

| Actor                       | Grants                                                | Trust                                                                    |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Deployment administrator    | installs extension code, sets rollout defaults        | trusts the code with the host process                                    |
| Conversation (office) owner | activates and configures per office                   | trusts the extension with that office's data and platform surface        |
| Extension author            | declares requirements (capabilities, secrets, config) | untrusted; declarations are checked, code is vetted by the administrator |

## Principles

1. **Artifact trust is deployment-scoped.** Extension code lives only in
   host-controlled directories and installing it is an administrator action
   (already true today; `loader.ts` preamble). Code is never per-office:
   an office never supplies code, only chooses among installed artifacts.
2. **Activation is office-scoped, and installation alone never activates.**
   Today a global install activates in every conversation with no opt-out —
   install (trust) and activation (tenant consent) are conflated, and a
   third concept, rollout policy (seed / recommend / mandate), has no home.
   Target: the loader loads resolved active bindings per office; a global
   install contributes a _default_, not a mandate. This is a behavioral
   migration and ships separately.
3. **Config and data follow the activation.** Per-office config/data under
   the office state dir, deployment level provides defaults only. Known
   deviation: extension secrets are global-by-slug
   (`vaults/extensions/<slug>` shared by all offices), which contradicts
   this principle and moves to activation-scoped bindings in a later stage.
4. **Storage is handle-scoped.** Extensions receive storage namespaced by
   `(slug, scope)` and never derive state-dir paths themselves. The current
   `paths.dataDir`/`paths.sharedDataDir` getters are the seam; a
   key-value `api.state` primitive on top of them is the planned next step
   so small extensions stop hand-rolling atomic JSON I/O.
5. **Runtime authority follows the activation principal.** Hooks, commands,
   and callback schedules run as the office that activated them — already
   true for schedules (they are keyed `ext.<slug>.<conversation>.`).
   Cross-office applications (e.g. agent-pm) currently borrow an office as
   a fake owner (`controlConversationId`); the honest concept is a
   _service activation_ owned by the deployment, to be introduced when the
   activation model ships. Extensions that need office fs/exec go through
   that office's executor, never a private filesystem API.
6. **In-process extensions are fully trusted — say so.** Extension modules
   run in the host process and can import `node:fs` directly; no API-shape
   rule changes that. Until an out-of-process/capability-sandboxed runtime
   exists, "extensions use the provided APIs" is a portability contract,
   not a security boundary. Documentation and review must not claim
   otherwise.

## Decided now: the capability contract

The first shippable slice, implemented alongside this ADR:

- `package.json` `mikan.requires` lists the host capabilities an extension
  needs (e.g. `schedules.callback`, `messaging.notify`, `secrets`). The loader
  checks declarations against the injected `ExtensionHostServices` _before
  importing_ the module; a miss is one clear activation error naming the
  extension and the missing capabilities, instead of a runtime throw at the
  first `api.*` call.
- `api.capabilities.has(name)` / `.list()` let an extension degrade
  gracefully without probing `typeof api.schedules?.onCallback`.
- The capability inventory has one home (`loader.ts`); `mikan ext validate`
  reports declared requirements and flags unknown names.
- `mikan ext init` scaffolds the golden-path extension (one command, one
  callback schedule, small state) so the first hour is copy-free.

## Deferred, in order

1. Activation records + rollout policy (installation ≠ activation), with
   office-level opt-out and migration of today's implicit activations.
2. `api.state` conversation/shared key-value primitive over the existing
   data dirs.
3. Activation-scoped secret bindings replacing global-by-slug vaults.
4. Service activations for cross-office applications.
5. Out-of-process extension runtime, only if third-party (non-administrator)
   code ever becomes a requirement.
