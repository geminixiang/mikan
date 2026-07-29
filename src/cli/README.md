# src/cli

CLI-only concerns of the `mikan` binary: the argv grammar and the subcommands that run instead of the daemon.

## Files

- `boot.ts`: Pure argv → `BootPlan` resolution — which mode to run (`ext`, `office`, `env`, `help`, `version`, `onboard`, `download`, `run`) and with what configuration — plus the `--help` text; `main.ts` executes the plan.
- `arg-grammar.ts`: Shared flag-grammar pieces other scanners must agree with `resolveBoot` on: the value-flag spelling (`--flag value` / `--flag=value`), the default state dir, and an early `--state-dir` probe for import-time consumers.
- `download.ts`: `mikan --download <channel>` — dumps a Slack channel's history, threads, and file listings.
- `ext.ts`: `mikan ext install|validate|list|remove` — manages extensions from the CLI; installs into the host-only state dir.
- `ext-dev.ts`: `mikan ext dev <path>` — a local REPL that activates an extension against a real harness, so an author can see `activate()` run without a Slack workspace, app, and deploy.
- `ext-git.ts`: Resolves a `mikan ext install` source that points at a git repository (clone, optional `#subpath`, dependency install) into a local directory for validation and copying.
- `office.ts`: `mikan office list|claim` — inspects registered offices and records which platform owns a legacy raw-id directory when several platforms are enabled and boot cannot infer ownership. The daemon performs the move on its next start, so run `claim` with the daemon stopped.
- `types.ts`: `BootPlan` and `ResolvedGitSource` — the shapes `boot.ts` and `ext-git.ts` hand to their executors.

The subcommands hold only a `--state-dir` string, so they address a
conversation through `officeStateDir(stateDir, address)` rather than a
`Workspace`/`Office` value (`src/office/README.md`).
