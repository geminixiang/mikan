# src/cli

CLI-only concerns of the `mikan` binary: the argv grammar and the subcommands that run instead of the daemon.

## Files

- `boot.ts`: Pure argv → `BootPlan` resolution — which mode to run (`ext`, `env`, `help`, `version`, `onboard`, `download`, `run`) and with what configuration — plus the `--help` text; `main.ts` executes the plan.
- `arg-grammar.ts`: Shared flag-grammar pieces other scanners must agree with `resolveBoot` on: the value-flag spelling (`--flag value` / `--flag=value`), the default state dir, and an early `--state-dir` probe for import-time consumers.
- `download.ts`: `mikan --download <channel>` — dumps a Slack channel's history, threads, and file listings.
- `ext.ts`: `mikan ext install|validate|list|remove` — manages extensions from the CLI; installs into the host-only state dir.
- `ext-git.ts`: Resolves a `mikan ext install` source that points at a git repository (clone, optional `#subpath`, dependency install) into a local directory for validation and copying.
