# src/cli

CLI-only concerns of the `mikan` binary: the argv grammar and the subcommands that run instead of the daemon.

## Files

- `onboard.ts`: The `mikan onboard` wizard — Clack arrow-key selections for adapter, LLM provider, and sandbox, masked secret input, and a final confirmation before writing. Choices derive from `ENV_MANIFEST` and the settings template; writes `settings.json`, `<state-dir>/mikan.env`, and `models.json` for custom endpoints. Cancel before confirmation writes nothing; an existing custom models file is never overwritten or printed with credentials. Non-TTY invocation retains template-only behavior.
- `boot.ts`: Pure argv → `BootPlan` resolution — which mode to run (`office`, `env`, `help`, `version`, `onboard`, `download`, `run`) and with what configuration — plus the `--help` text; `main.ts` executes the plan.
- `arg-grammar.ts`: Shared Commander configuration, value validation, exit-code handling, the default state dir, and an early `--state-dir` probe for import-time consumers. Commander owns option parsing and generated usage; `BootPlan` and command actions retain execution ownership.
- `download.ts`: `mikan --download <channel>` — dumps a Slack channel's history, threads, and file listings.
- `office.ts`: `mikan office list|claim|migrate-openconnector` — inspects registered offices and records which platform owns a legacy raw-id directory when several platforms are enabled and boot cannot infer ownership. The daemon performs the move on its next start, so run `claim` with the daemon stopped. `migrate-openconnector` converts legacy per-office `open-connector-runtime-token.json` files into ordinary conversation `mcpServers` entries for the current `OPENCONNECTOR_ENDPOINT`; also run it with the daemon stopped.
- `sessions.ts`: `mikan sessions migrate` — offline-converts legacy mikan v3 and Pi 0.84-generation v4 session files to the current Pi v4 format. Run with the daemon stopped; originals remain as `*.v3.bak` or `*.pi-084.bak`. Supports `--state-dir`, `--workspace`, and `--dry-run`.
- `types.ts`: `BootPlan` — the shape `boot.ts` hands to `main.ts`.

CLI subcommands pass explicit path strings rather than a `Workspace`/`Office`
value. Office paths use `officeStateDir(stateDir, address)`; session migration
scans its workspace path directly (`src/office/README.md`).
