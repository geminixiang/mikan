---
title: Image sandbox
description: Use mikan-managed per-conversation Docker containers and vault isolation.
---

```bash
# Pull the prebuilt image from GHCR
# Only mikan releases publish the image: :<version>, :latest, :tools, and :beta for prereleases
docker pull ghcr.io/geminixiang/mikan-sandbox:latest

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:latest /path/to/workspace
```

If you want to customize the image yourself, you can also build locally:

```bash
docker build -f deploy/docker/mikan-sandbox.Dockerfile -t mikan-sandbox:latest .
mikan --sandbox=image:mikan-sandbox:latest /path/to/workspace
```

Features:

- the standard tool image includes Node.js 24, Chromium, ffmpeg, and the pinned `agent-browser` 0.38.1 runtime used by `jev_browser`
- the image installs its tools under `/usr/local` and `/opt`, never under `/root`; `npm i -g`, `uv tool install`, and `pip install --user` from inside the sandbox go to `/root/.local`, which is on `PATH`
- mikan creates an isolated vault and container for each conversation
- each container gets its own Docker bridge network, separating direct container-to-container networking; outbound network access remains enabled
- managed containers are created with `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and `--pids-limit=1024`
- inside the container, workspace mounts follow explicit settings or recorded Slack channel visibility; public channels share workspace memory read-write, private channels receive it read-only, and DMs/external/unknown conversations stay isolated
- vault env is injected at execution time
- vault file credentials are automatically bind-mounted into the container, at a target inferred from each file's name (see [Vault](/sandbox/vault/))
- idle containers are checked every 10 minutes and stopped after at least 10 minutes of inactivity; depending on scan timing, stopping occurs roughly 10–20 minutes after last tracked use

## Upgrading the sandbox image

A managed container is the image plus a per-office home volume `mikan-home-<key>` mounted at
`/root`. Workspace mounts and `/root` (npm/uv/pip caches, `~/.local`, dotfiles) survive an upgrade;
anything else written to the container filesystem (`apt install`, `/etc` edits, `/tmp`) does not.

1. Pull the new image on the host under the tag mikan runs with (`docker pull …:latest`). mikan never
   pulls by itself; keep the previous image ID around for rollback.
2. Containers created with a home volume pick up the new image automatically: a running container
   is never interrupted, and once it has been stopped for idleness, the next message replaces it
   (`docker rm` + `docker run` with the same volume).
3. Containers created before home volumes are left alone. With the daemon stopped, inspect and
   migrate them in small batches:

```bash
mikan sandbox status --image ghcr.io/geminixiang/mikan-sandbox:latest
mikan sandbox diff <container-key> --image ghcr.io/geminixiang/mikan-sandbox:latest
mikan sandbox migrate <container-key>... --image ghcr.io/geminixiang/mikan-sandbox:latest
```

`status` lists each container as `legacy`/`home-volume` and `current-image`/`stale-image`. `diff`
lists the system paths an upgrade will discard. `migrate` seeds the home volume from the
container's current `/root`, then recreates it from the current image.

Rollback: re-tag the previous image ID and let containers be replaced again; the home volume is
kept as-is. `/login` recreates the container but keeps its home volume.

## Mounts and the conversation office

The conversation's office directory is bind-mounted read-write at `/workspace/<office-key>`, where
the office key is the `v1-<platform>-<readable-id>-<hash>` segment that also names the directory on
the host. An `isolated` projection makes that the only workspace mount; trusted `shared-support`
adds the workspace-global `MEMORY.md`, `skills/`, and `events/`. Private visibility marks the global
memory bind read-only, while public visibility leaves it read-write. `trusted` / `full` mounts the
whole workspace root at `/workspace`.

Changing the door policy updates the mounts on the next message. A container with a home volume
is recreated from the current image, keeping `/root` and workspace mounts but discarding other
container filesystem changes. A legacy container without a home volume instead uses a snapshot
to preserve its writable layer. The same paths cover office-directory renames during boot-time
layout migration.

## Vault and container keys

Credentials are keyed by **office key**: the vault directory for a conversation is
`~/.mikan/vaults/<office-key>/`. The key is derived by hashing the platform name together with the
platform's raw conversation id, so two platforms that happen to use the same raw id can never
resolve each other's credentials. Conversation vault directories written under the older raw-id
scheme are renamed to office keys by the boot-time migration.

The managed container is named `mikan-sandbox-<resource-key>`, and its network
`mikan-sandbox-net-<resource-key>`. The resource key is still derived from the raw conversation id
(a sanitized prefix plus a short digest) — renaming it would churn every provisioned container, so
it migrates separately. A collision there costs a container recreate, never credential access.

Suitable for:

- multiple users sharing one mikan instance
- per-conversation env/file credential isolation
- managed filesystem projection and stronger isolation than a shared container

## Container resource limits

In `settings.json`, you can configure CPU and memory limits for each managed container:

```json
{
  "sandbox": {
    "cpus": "0.5",
    "memory": "512m",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    }
  }
}
```

| Field                  | Description                                           | Example values   |
| ---------------------- | ----------------------------------------------------- | ---------------- |
| `sandbox.cpus`         | CPU core limit (floating-point string)                | `"0.5"`, `"2"`   |
| `sandbox.memory`       | Memory limit (Docker memory format)                   | `"512m"`, `"2g"` |
| `sandbox.boost.cpus`   | Temporary CPU limit applied by `/pi-sandbox boost`    | `"2"`, `"4"`     |
| `sandbox.boost.memory` | Temporary memory limit applied by `/pi-sandbox boost` | `"4g"`, `"8g"`   |

- when creating a new container, limits are added directly to `docker run`
- running containers receive new limits immediately through `docker update` on the next provision, without recreation
- `/pi-sandbox` shows the current conversation's effective limits plus its door policy and layout
- `/pi-sandbox boost` temporarily upgrades the current conversation to the `sandbox.boost` spec; boost state follows the container and ends when the container stops
- `/pi-sandbox door <default|isolated|shared|shared-private|full>` switches this office's door policy; the container is recreated with the new mounts on the next message and keeps its contents
- the agent can use the built-in `sandbox` tool to inspect or temporarily set the current conversation's CPU / memory limit; these overrides are also cleared when the container stops
