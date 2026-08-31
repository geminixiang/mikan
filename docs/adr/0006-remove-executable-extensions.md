---
status: accepted
---

# Remove executable extensions and keep packages skills-only

mikan no longer loads third-party executable modules into its host process.
The extension loader, registry, hooks, extension commands, schedules, secrets
UI, CLI management, package executable discovery, and extension public API are
removed as one breaking change.

The extension host exposed broad process authority across the harness,
Conversation runtime, platform adapters, Admin, CLI, schedules, vaults, and
package loading. Repository implementations were experiments, while the real
integration need was narrower: deliver reusable agent instructions and support
future host-mediated Sandbox capabilities. Preserving a hooks-only or
tools-only compatibility layer would retain most of the trusted-host seam
without a demonstrated implementation that justified it.

Packages remain as the materialization and scope-precedence authority for
standalone skills. mikan discovers `skills/<name>/SKILL.md` from resolved
packages and mounts those skill directories read-only into the Sandbox. It
does not import package modules or treat a package root as executable code.

Existing extension directories, data, schedules, and secrets are not deleted
or migrated automatically. They simply stop being loaded. The legacy
`vaults/extensions/` namespace remains reserved so old files cannot be
mistaken for a user vault or injected into a Sandbox. Operators may remove old
assets manually after reviewing them.

Future Sandbox-to-host behavior must use a narrow, explicit capability owned by
the relevant runtime or platform module. It must not recreate a general
host-process plugin API.
