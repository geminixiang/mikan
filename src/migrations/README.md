# src/migrations

Every conversion of persisted files from an older format lives here ([ADR 0014](../../docs/adr/0014-versioned-state-migrations.md)). Other modules read and write only the current format.

## Contracts

- `MIGRATIONS` in `index.ts` is an ordered list of numbered steps. Append new steps; never renumber, reorder, or edit a released step, because `<state-dir>/migrations.json` records applied steps by ID.
- The supported starting point is the 0.5.3 layout. A format that only a 1.0.0 prerelease wrote gets no step.
- `mikan migrate` (`src/cli/migrate.ts`) is the only runner. The daemon refuses to start while a step is pending and never converts anything itself. `mikan onboard` records every step as applied, because a new State dir has nothing to convert.
- Each step is idempotent: with nothing to convert it does nothing and is recorded as applied. Resolve anything ambiguous before writing, and throw with the path and the fix, for example `--owner <conversationId>=<platform>` or "merge A into B". A failed step is not recorded, and the steps before it stay applied.
- With `dryRun`, a step reports each change through `report` and writes nothing.
- Steps that need the deployment's sandbox mode get it from `--sandbox`, which must match the daemon's. Host and container vault names depend on it.
- A step that talks to Docker uses the injected `DockerCli`. A missing `docker` executable means there are no containers to handle.
