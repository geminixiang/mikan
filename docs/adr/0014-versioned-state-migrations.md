---
status: accepted
---

# Versioned state migrations and disposable sandbox containers

Changes to persisted files are applied by `mikan migrate`, an ordered list of numbered migrations recorded in `<state-dir>/migrations.json`. The daemon refuses to start while any migration is pending and never rewrites legacy state itself. The supported upgrade path is from the last stable release, 0.5.3; formats that existed only in 1.0.0 prereleases are not migrated. Sandbox containers keep no state across an image or configuration change: only the workspace and the vault persist.

## Context

Between 0.5.3 and the 1.0.0 prereleases, legacy state was converted in four different ways:

- at daemon startup (office directories, vault keys, host state directories, container bind mounts);
- lazily on first read (conversation `settings.json`);
- by separate subcommands that each required a stopped daemon (`sessions migrate`, `office migrate-events`, `office migrate-openconnector`, `office migrate-door-policy`, `sandbox migrate`);
- by leaving old containers in place and snapshotting them into `mikan-migrate:` images.

Running a real 0.5.3 install and upgrading it showed what this cost:

- The vault key migration looked for a key format that 0.5.3 never wrote, so 0.5.3 conversation credentials were silently left behind.
- Workspace events and v3 sessions were not converted unless the operator knew to run the matching subcommand.
- The container layout migration recreated 0.5.3 containers from snapshots under their old names, next to the new office-keyed containers.

A production survey of 54 sandbox containers found that `/root` held caches, vault mount points, and CLI token caches, and nothing else. Keeping those environments across image upgrades required home volumes, snapshot images, per-container diffs, and upgrade downtime of about 97 seconds per container.

## Considered Options

- **Numbered migrations run only by `mikan migrate` (chosen)**: one place owns every legacy format, the order is fixed, and a run can be previewed with `--dry-run`.
- **Run pending migrations automatically at startup**: convenient, but moving files on an unattended restart is the behavior that hid the failures above.
- **Keep per-format subcommands**: each operator has to know which ones apply to their install.

For containers:

- **Disposable containers (chosen)**: a stopped container whose image or mounts no longer match is replaced; nothing but the workspace and the vault survives.
- **Home volumes that keep `/root`**: preserve caches, at the cost of migration code, snapshot images, and downtime.

## Consequences

- Supersedes [ADR 0009](0009-sandbox-persistence-model.md): there is no per-office home volume, and a replaced container starts with an empty `/root`.
- The supported starting point is narrowed by [ADR 0019](0019-migrations-start-from-0-5-3-only.md): only 0.5.3, and steps that served only prerelease installs are removed before 1.0.0.

- `src/migrations/` owns every legacy format. Other modules read and write only the current format.
- Each migration is idempotent: with nothing to convert it records itself as applied, so a new install, a 0.5.3 install, and an up-to-date prerelease install all run the same command.
- `mikan onboard` records every migration as applied, because a new state directory has nothing to convert.
- Upgrading requires stopping the daemon, running `mikan migrate`, and starting the daemon.
- Removed: `mikan office`, `mikan sessions migrate`, `mikan sandbox`, startup office migration, lazy settings moves, and the OpenConnector token, door-policy, and Pi 0.84 session conversions, which only prereleases needed.
- Packages installed in a container outside the workspace disappear when its image changes. The system prompt tells the agent to keep durable files in the workspace.
