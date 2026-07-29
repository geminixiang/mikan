---
title: Image sandbox
description: Use mikan-managed per-conversation Docker containers and vault isolation.
---

```bash
# Pull the prebuilt image from GHCR
# Release builds publish :tools, :<version>, and :latest / :beta
# Pushes to main also publish :edge
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

- mikan creates an isolated vault and container for each conversation
- each container gets its own Docker bridge network, separating direct container-to-container networking; outbound network access remains enabled
- managed containers are created with `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and `--pids-limit=1024`
- inside the container, the default isolated policy exposes only the conversation's own office directory; Admin can explicitly choose a trusted shared-support or full-workspace layout
- vault env is injected at execution time
- vault file credentials are automatically bind-mounted into the container, at a target inferred from each file's name (see [Vault](/sandbox/vault/))
- idle containers are checked every 10 minutes and stopped after at least 10 minutes of inactivity; depending on scan timing, stopping occurs roughly 10–20 minutes after last tracked use

## Mounts and the conversation office

The conversation's office directory is bind-mounted read-write at `/workspace/<office-key>`, where
the office key is the `v1-<platform>-<readable-id>-<hash>` segment that also names the directory on
the host. Under the default `isolated` door policy that is the only workspace mount; a trusted
`shared-support` layout adds the workspace-global `MEMORY.md`, `skills/`, and `events/`, and
`trusted` / `full` mounts the whole workspace root at `/workspace`. Skills shipped by a package
mount read-only outside `/workspace`, at `/mikan/packages/<slug>/skills`.

Changing the door policy does not reset the container. When the desired mounts no longer match the
running container, mikan snapshots it, recreates it with the translated mounts, and starts it again,
so anything installed or written in the container's own filesystem survives the change. The same
path covers the office-directory rename performed by the boot-time layout migration.

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
- better safety than a shared container without going all the way to Firecracker

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
- `/pi-sandbox door <default|isolated|shared|full>` switches this office's door policy; the container is recreated with the new mounts on the next message and keeps its contents
- the agent can use the built-in `sandbox` tool to inspect or temporarily set the current conversation's CPU / memory limit; these overrides are also cleared when the container stops
