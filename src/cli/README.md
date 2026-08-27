# src/cli

CLI-only concerns of the `mikan` binary: the argv grammar and the subcommands that run instead of the daemon.

## Files

- `onboard.ts`: The `mikan onboard` wizard — three questions (adapter, LLM provider, sandbox) derived from `ENV_MANIFEST` and the settings template; writes `settings.json`, `<state-dir>/mikan.env`, and `models.json` for custom endpoints.
- `boot.ts`: Pure argv → `BootPlan` resolution — which mode to run (`ext`, `office`, `env`, `help`, `version`, `onboard`, `download`, `run`) and with what configuration — plus the `--help` text; `main.ts` executes the plan.
- `arg-grammar.ts`: Shared flag-grammar pieces other scanners must agree with `resolveBoot` on: the value-flag spelling (`--flag value` / `--flag=value`), the default state dir, and an early `--state-dir` probe for import-time consumers.
- `download.ts`: `mikan --download <channel>` — dumps a Slack channel's history, threads, and file listings.
- `ext.ts`: `mikan ext install|validate|list|remove|dev` — manages extensions from the CLI; installs into the host-only state dir. `ext dev` is a local REPL that activates an extension against a real harness, so an author can see `activate()` run without a Slack workspace, app, and deploy. Git sources materialize through `packages/` (cached clone under the scope's `git/` dir, `@ref` + `#subpath` supported).
- `office.ts`: `mikan office list|claim` — inspects registered offices and records which platform owns a legacy raw-id directory when several platforms are enabled and boot cannot infer ownership. The daemon performs the move on its next start, so run `claim` with the daemon stopped.
- `types.ts`: `BootPlan` — the shape `boot.ts` hands to `main.ts`.

The subcommands hold only a `--state-dir` string, so they address a
conversation through `officeStateDir(stateDir, address)` rather than a
`Workspace`/`Office` value (`src/office/README.md`).
