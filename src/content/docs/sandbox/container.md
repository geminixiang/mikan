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
- the vault key is:

```text
container-<name>
```

For example:

```bash
--sandbox=container:mikan-tools
```

uses:

```text
~/.mikan/vaults/container-mikan-tools/
```

This is **one container one vault**:

- different containers have different vaults
- multiple users sharing the same container also share the same container vault

Limitations:

- mikan injects env only during `docker exec`
- `docker exec` cannot add bind mounts
- vault file credentials are saved, but are not automatically projected to the target path inside the container yet
