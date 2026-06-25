---
title: Image sandbox
description: Use mikan-managed per-conversation Docker containers and vault isolation.
---

```bash
# Pull the prebuilt image from GHCR
# Release builds publish :tools, :<version>, and :latest / :beta
# Pushes to main also publish :edge
docker pull ghcr.io/geminixiang/mikan-sandbox:tools

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:tools /path/to/workspace
```

If you want to customize the image yourself, you can also build locally:

```bash
docker build -f docker/mikan-sandbox.Dockerfile -t mikan-sandbox:tools .
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

Features:

- mikan creates an isolated vault and container for each conversation
- each container gets its own Docker bridge network and is isolated from others by default
- managed containers are created with `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and `--pids-limit=1024`
- inside the container, only `/workspace/MEMORY.md`, `/workspace/skills`, `/workspace/events`, and the current conversation directory are visible
- vault env is injected at execution time
- vault file credentials are automatically bind-mounted into the container according to the target path
- idle containers are stopped automatically; the next run starts or recreates them as needed

Vault key selection logic:

1. use the conversation ID directly as the vault key, for example `d123`
2. that conversation's credentials / mounts / env are written to this vault
3. the corresponding managed container uses the same key, for example `mikan-sandbox-d123`

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
- `/pi-sandbox` shows the current conversation's effective limits
- `/pi-sandbox boost` temporarily upgrades the current conversation to the `sandbox.boost` spec; boost state follows the container and ends when the container stops
- the agent can use the built-in `sandbox` tool to inspect or temporarily set the current conversation's CPU / memory limit; these overrides are also cleared when the container stops
