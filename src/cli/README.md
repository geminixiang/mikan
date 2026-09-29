# src/cli

CLI-only concerns of the `mikan` binary: the argv grammar and the subcommands that run instead of the daemon.

## Contracts

- `boot.ts` resolves argv into a `BootPlan` without side effects, and `main.ts` executes it. Commander owns option parsing and usage text.
- `mikan migrate` is the only subcommand that moves state, and it requires a stopped daemon. Its steps live in `src/migrations/`.
- `mikan onboard` writes nothing when cancelled before confirmation, and never overwrites or prints an existing custom `models.json`.
- Shutdown steps in `process-lifecycle.ts` run in order and never skip a later step when an earlier one fails.
