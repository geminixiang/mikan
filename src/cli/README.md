# src/cli

CLI-only concerns of the `mikan` binary: the argv grammar and the subcommands that run instead of the daemon.

## Files

- `onboard.ts`: The `mikan onboard` wizard — three questions (adapter, LLM provider, sandbox) derived from `ENV_MANIFEST` and the settings template; writes `settings.json`, `<state-dir>/mikan.env`, and `models.json` for custom endpoints.
- `boot.ts`: Pure argv → `BootPlan` resolution — which mode to run (`office`, `env`, `help`, `version`, `onboard`, `download`, `run`) and with what configuration — plus the `--help` text; `main.ts` executes the plan.
- `arg-grammar.ts`: Shared flag-grammar pieces other scanners must agree with `resolveBoot` on: the value-flag spelling (`--flag value` / `--flag=value`), the default state dir, and an early `--state-dir` probe for import-time consumers.
- `download.ts`: `mikan --download <channel>` — dumps a Slack channel's history, threads, and file listings.
- `office.ts`: `mikan office list|claim` — inspects registered offices and records which platform owns a legacy raw-id directory when several platforms are enabled and boot cannot infer ownership. The daemon performs the move on its next start, so run `claim` with the daemon stopped.
- `sessions.ts`: `mikan sessions migrate` — offline-converts legacy mikan v3 and Pi 0.84-generation v4 session files to the current Pi v4 format. Run with the daemon stopped; originals remain as `*.v3.bak` or `*.pi-084.bak`. Supports `--state-dir`, `--workspace`, and `--dry-run`.
- `types.ts`: `BootPlan` — the shape `boot.ts` hands to `main.ts`.

CLI subcommands pass explicit path strings rather than a `Workspace`/`Office`
value. Office paths use `officeStateDir(stateDir, address)`; session migration
scans its workspace path directly (`src/office/README.md`).
