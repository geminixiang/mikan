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

- the standard tool image includes Node.js 24, Chromium, CJK fonts, ffmpeg, and the pinned `agent-browser` 0.38.1 runtime used by `jev_browser`
- the image installs its tools under `/usr/local` and `/opt`, never under `/root`; `npm i -g` and `uv tool install` from inside the sandbox go to `/root/.local`, which is on `PATH`; Python packages go through uv (`uv run --with <package>`), because the system pip refuses installs
- mikan creates an isolated vault and container for each conversation
- each container gets its own Docker bridge network, separating direct container-to-container networking; outbound network access remains enabled
- managed containers are created with `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and `--pids-limit=1024`
- inside the container, workspace mounts follow explicit settings or recorded Slack channel visibility; public channels share workspace memory read-write, private channels receive it read-only, and DMs/external/unknown conversations stay isolated
- vault env is injected at execution time
- vault file credentials are automatically bind-mounted into the container, at a target inferred from each file's name (see [Vault](/sandbox/vault/))
- idle containers are checked every 10 minutes and stopped after at least 10 minutes of inactivity; depending on scan timing, stopping occurs roughly 10–20 minutes after last tracked use

## Upgrading the sandbox image

A managed container is disposable. Only its bind mounts (the conversation office, shared knowledge,
and vault files) outlive it; anything written elsewhere in the container, including `/root`, package
installs, and `/etc` edits, is discarded when the container is replaced. Keep anything durable in
the workspace.

1. Pull the new image on the host under the tag mikan runs with (`docker pull …:latest`). mikan never
   pulls by itself; keep the previous image ID around for rollback.
2. A running container is never interrupted. Once a container has been stopped for idleness, the
   next message replaces it from the new image (`docker rm` + `docker run`).

Rollback: re-tag the previous image ID and let containers be replaced again.

## Mounts and the conversation office

The conversation's office directory is bind-mounted read-write at `/workspace/<office-key>`, where
the office key is the `v1-<platform>-<readable-id>-<hash>` segment that also names the directory on
the host. An `isolated` projection makes that the only workspace mount; trusted `shared-support`
adds the workspace-global `MEMORY.md`, `skills/`, and `events/`. Private visibility marks the global
memory bind read-only, while public visibility leaves it read-write. `trusted` / `full` mounts the
whole workspace root at `/workspace`.

When the mounts change, for example after a visibility change, the next message replaces the
container from the current image.

## Vault and container keys

Credentials are keyed by **office key**: the vault directory for a conversation is
`~/.mikan/vaults/<office-key>/`. The key is derived by hashing the platform name together with the
platform's raw conversation id, so two platforms that happen to use the same raw id can never
resolve each other's credentials. `mikan migrate` renames 0.5.3 vault directories, which used the raw
conversation id, to office keys.

The managed container is named `mikan-sandbox-<office-key>`, and its network
`mikan-sandbox-net-<office-key>`.

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
