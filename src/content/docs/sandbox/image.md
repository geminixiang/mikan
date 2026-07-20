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
- each container gets its own Docker bridge network, separating direct container-to-container networking; outbound network access remains enabled
- managed containers are created with `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and `--pids-limit=1024`
- inside the container, only `/workspace/MEMORY.md`, `/workspace/skills`, `/workspace/events`, and the current conversation directory are visible
- vault env is injected at execution time
- vault file credentials are automatically bind-mounted into the container according to the target path
- idle containers are checked every 10 minutes and stopped after at least 10 minutes of inactivity; depending on scan timing, stopping occurs roughly 10–20 minutes after last tracked use

Vault key selection logic:

1. normalize the conversation ID to lowercase, replace non-alphanumeric runs with `-`, trim dashes, and use `unknown` if nothing remains
2. write that conversation's credentials, mounts, and env to the normalized vault key
3. use the same normalized key for the managed container, for example `mikan-sandbox-d123`

Because normalization can collapse different raw IDs to the same value, avoid manually constructed platform IDs that differ only by punctuation or case.

Suitable for:

- multiple users sharing one mikan instance
- per-conversation env/file credential isolation

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
