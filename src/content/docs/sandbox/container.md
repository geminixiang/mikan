---
title: Container sandbox
description: Run mikan commands in an existing Docker container and allocate vaults by container name.
---

```bash
docker run -d --name mikan-tools   --cap-drop=ALL   --security-opt=no-new-privileges   --pids-limit=1024   -v /path/to/workspace:/workspace   alpine:latest sleep infinity

mikan --sandbox=container:mikan-tools /path/to/workspace
```

Features:

- mikan uses `docker exec` to run commands in an existing container
- the workspace inside the container is expected at `/workspace`
- when creating the container, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, and `--pids-limit=1024` are recommended to avoid extra privileges and limit runaway processes

## Vault key

The vault key is derived from the container name — a readable prefix plus a short digest of that
name, so `--sandbox=container:mikan-tools` uses `~/.mikan/vaults/mikan-tools-<digest>/`. mikan
generates the exact directory when `/pi-login` writes credentials; vault directories written before
the digest was introduced (`container-<name>`) are still read.

Either way the semantics are **one container one vault**:

- different containers have different vaults
- multiple users sharing the same container also share the same container vault

Unlike the conversation-scoped modes, the key does not depend on the conversation, so a container
vault is not a per-conversation credential boundary.

## Door policy

`container:*` cannot enforce a conversation-scoped workspace projection — `docker exec` cannot add
mounts to a container mikan did not create — so it refuses to run under the default `isolated` door
policy. Choose a trusted policy explicitly in the global `settings.json` or the admin portal (the
`/pi-sandbox` chat command only serves managed sandboxes), and mount the workspace yourself when you
create the container.

## Limitations

- mikan injects env only during `docker exec`
- `docker exec` cannot add bind mounts, so **file credentials are refused rather than skipped**: if this container's vault holds any file besides `env`, the run fails with `Sandbox type "container" does not support vault file mounts`. Keep credentials in `env` here.
- mikan does not manage this container's lifecycle, resource limits, or `/pi-sandbox boost`
