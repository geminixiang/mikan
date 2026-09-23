---
status: proposed
---

# A managed sandbox is an image plus a home volume

A managed `image:*` sandbox is a disposable container built from two durable parts: the image, which mikan owns, and a per-office named volume at `/root`, which the user owns. Workspace directories stay host bind mounts. Anything else written to the container filesystem (`/usr`, `/etc`, `/var`, `/tmp`) belongs to that container instance and does not survive a runtime upgrade. Upgrading means `docker rm` and `docker run` with the same volume.

Each rule below uses a Docker or Linux mechanism that already exists. mikan adds no locks, snapshots, replay, or quota logic of its own.

## Context

Users treat the sandbox as a VM, and existing containers never pick up a new image. In production on 2026-09-23, 49 of 51 managed containers still ran an old base image after `1.0.0-beta.77`. About 95% of the paths changed in their writable layers were under `/root` (`.cache`, `.npm`, `.local`, `.nvm`, `.config`). The rest were a few hundred apt changes under `/usr`, `/etc`, and `/var`.

Today mikan keeps user state by running `docker commit` on the container and recreating it from that snapshot whenever mounts or networks drift. The snapshot preserves the old base image, so the runtime never updates. Every re-login also causes a full recreate: vault credentials are bind-mounted as single files, an atomic-rename update leaves the container holding the old inode, and mikan therefore hashes file contents into a `mikan.mount-signature` label to detect the change.

The sandbox serves a team sharing one VM. Its job is resource limits, filesystem isolation, and environment isolation between offices. It is not a hostile multi-tenant boundary like E2B or a SaaS sandbox: containers share the host kernel and the people on the VM trust each other. Credentials enter the sandbox only because development work needs them, so the design keeps that surface small rather than building a secret-management layer.

## Decision

| Path                           | Mechanism                       | On upgrade                                      |
| ------------------------------ | ------------------------------- | ----------------------------------------------- |
| runtime (`/usr/local`, `/opt`) | image                           | replaced                                        |
| `/root`                        | named volume `mikan-home-<key>` | kept                                            |
| `/workspace/*`                 | host bind mounts (unchanged)    | kept                                            |
| vault                          | read-only directory binds       | re-read live; never copied                      |
| `/usr`, `/etc`, `/var`, `/tmp` | container writable layer        | discarded; listed beforehand with `docker diff` |

1. **The runtime lives outside `/root`.** Node, agent-browser, gcloud, uv, bun, and similar tools install under `/usr/local` or `/opt`. Tools run via `docker exec … sh -c`, which does not read `.bashrc` or nvm, so a user's changes to home cannot shadow the image runtime. Harness tools keep calling commands by name.
2. **Home is a named volume.** When an empty named volume is first mounted, Docker copies the image's content at that path into it. That copy is how a new office gets its initial home, and also how an existing office migrates: run its current snapshot once with an empty volume at `/root`. mikan does not snapshot volumes. Rollback means running the previous image ID with the same volume, so changes made to home by the newer runtime stay.
3. **Vault mounts are directories, never single files.** Mounting a directory read-only shows atomic-rename updates immediately. Tools locate credentials inside it through their documented environment variables (`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`, `KUBECONFIG`, `GH_TOKEN`, …). A credential with no such variable still gets a directory bind at its conventional path (for example `/root/.ssh`). The mount set changes only when an entry is added or removed, so comparing bind specs is enough to detect drift, and content hashing goes away.
4. **Credential helpers are configured through the environment.** Git's `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` travel in the per-exec `--env-file` next to the token. Nothing is written into home, so a token that has been revoked leaves no lasting helper configuration behind.
5. **Image drift is two inspects.** A container whose `.Image` differs from the local tag's image ID is stale. It is replaced the next time it is stopped, never while it is running. mikan never pulls; deployments pull and keep the previous image for rollback. Mount and network drift keep today's behavior and apply before new work runs.
6. **Serialization stays in-process.** A state dir has exactly one mikan process, so a per-key promise chain in the provisioner orders `provision`, `stop`, and `remove`. Docker rejects a duplicate `--name`, which catches anything outside that chain.
7. **Volumes are ordinary Docker objects.** They are labeled `mikan.managed=true` and `mikan.vault-id=<key>`, removed together with the office, and measured with `docker system df -v`. Whether a container is volume-backed is read from `.Mounts`; there is no layout-version label.

## Rollout

1. Move the runtime out of `/root` in the image, and smoke-test it with an empty `/root`.
2. Switch vault mounts to directory binds plus environment variables, and remove `mount-signature`. Move git credential setup into the environment.
3. Create new offices with a home volume. Replace volume-backed containers that show image drift when they stop.
4. Opt-in migration of existing offices: show `docker diff` filtered to non-home paths, then run the current snapshot once with an empty volume to populate it, then recreate the container from the new image. Small batches, confirmed by an operator.
5. Once no containers without a volume remain, delete the commit-based recreate path (`mikan-migrate` images, the `mikan.migrate-binds` label, stale-mountpoint cleanup).

Existing containers are left untouched until step 4.

## Considered Options

- **Image plus home volume (chosen).** Upgrades, rollback, and migration all come down to `docker run`.
- **Keep `docker commit` recreation.** Rejected: it permanently pins the old base image.
- **Upgrade the runtime in place inside each container.** Rejected: every container is a different, user-modified root.
- **Rebase the writable layer onto the new image, or replay apt installs.** Rejected: Docker does not support rebasing, and replay cannot capture `dpkg -i`, third-party sources, removals, or `/etc` edits.
- **Custom machinery (flock, cache quotas, layout-version labels).** Rejected: a single process, Docker name uniqueness, `docker system df`, and `.Mounts` already provide these.

## Consequences

- User docs state the narrower promise: workspace and home persist, while system changes and `/tmp` are lost on an upgrade. The next session can reinstall what it needs.
- Each office owns one named volume that follows the office's lifecycle.
- Until an office migrates, it keeps its old runtime.
- `container:*`, host, and Cloudflare backends are unaffected.
