# src/migrations

Every conversion of persisted files from an older format lives here ([ADR 0014](../../docs/adr/0014-versioned-state-migrations.md), [ADR 0019](../../docs/adr/0019-migrations-start-from-0-5-3-only.md)). Other modules read and write only the current format.

## Contracts

- `MIGRATIONS` in `index.ts` is an ordered list of numbered steps. Append new steps; once 1.0.0 is released, never renumber, reorder, or edit a released step, because `~/.mikan/migrations.json` records applied steps by ID. Unknown IDs in that record are ignored, so a removed step does not reappear as pending. New steps are numbered after 0013; `0010` and `0011` were removed and are never reused.
- The only supported upgrade is from 0.5.3 to 1.0.0. A step whose only users are 1.0.0 prerelease installs is not added, and before 1.0.0 is released such a step is removed.
- `mikan migrate` (`src/cli/migrate.ts`) is the only runner. With steps pending, it refuses to start unless `~/.mikan/settings.json` and the workspace exist, because a missing `~/.mikan` or `--workspace` otherwise finds nothing to convert, records every step as applied, and leaves a rerun with the right paths nothing to do. The daemon refuses to start while a step is pending and never converts anything itself. `mikan onboard` records every step as applied, because a new State dir has nothing to convert.
- Each step is idempotent: with nothing to convert it does nothing and is recorded as applied. Resolve anything ambiguous before writing, and throw with the path and the fix, for example `--owner <conversationId>=<platform>` or "merge A into B". A failed step is not recorded, and the steps before it stay applied.
- With `dryRun`, a step reports each change through `report` and writes nothing.
- Steps that need the deployment's sandbox mode get it from `--sandbox`, which must match the daemon's. Host and container vault names depend on it.
- A step that talks to Docker uses the injected `DockerCli`. A missing `docker` executable means there are no containers to handle.
