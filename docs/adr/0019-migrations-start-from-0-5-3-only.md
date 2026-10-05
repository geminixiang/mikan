---
status: accepted
---

# Migrations start from 0.5.3 only

ADR 0014 made 0.5.3 the supported starting point and said formats that only 1.0.0 prereleases wrote get no migration. Two prerelease releases broke that rule: `0010-dream-checkpoints` deleted the checkpoints of Dream, which 0.5.3 never had, and `0011-private-office-dirs` tightened directories that prerelease daemons had created with loose permissions. Running the 0.5.3 path alone produces the same result without them: there are no Dream checkpoints, and every office state directory it creates already has mode 700.

## Decision

`mikan migrate` supports exactly one upgrade, from 0.5.3 to 1.0.0. A step that serves only a prerelease install is removed, so `0010-dream-checkpoints` and `0011-private-office-dirs` are gone. Until 1.0.0 is released, a step may also be rewritten if the 0.5.3 path stays correct. From 1.0.0 on, ADR 0014's rule applies to released steps: append, never renumber, reorder, or edit them.

## Considered Options

- **0.5.3 only (chosen)**: one upgrade path to test and document, and no code for formats that never reach a supported install.
- **0.5.3 and every prerelease since `mikan migrate` (1.0.0-beta.85)**: describes what the prerelease steps did, but keeps code whose only users are prerelease installs, and every later step would have to consider each prerelease format.
- **Keep the rule and list the two steps as exceptions**: the documented promise and the code would still disagree.

## Consequences

- A 1.0.0 prerelease install is not a supported starting point. One that already applied the removed steps keeps their IDs in `migrations.json`; unknown IDs are ignored, so nothing is pending and nothing reruns.
- A prerelease install that upgrades directly to 1.0.0 without having applied them keeps any `dream.json` files and any office state directory with permissions looser than 700. Operators can delete the files and run `chmod -R go-rwx <state-dir>/conversations`.
- New steps take numbers after 0011, so a removed ID is never reused for a different step.
