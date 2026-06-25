---
title: Container sandbox
description: 使用现有 Docker container 执行 mikan commands，并以 container 名称分配 vault。
---

```bash
docker run -d --name mikan-tools \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=1024 \
  -v /path/to/workspace:/workspace \
  alpine:latest sleep infinity

mikan --sandbox=container:mikan-tools /path/to/workspace
```

特性：

- mikan 使用 `docker exec` 在既有 container 中执行 command
- container 内 workspace 预期是 `/workspace`
- 建议创建 container 时加上 `--cap-drop=ALL`、`--security-opt=no-new-privileges` 与 `--pids-limit=1024`，避免 container 内程序获取额外权限并限制 runaway process
- vault key 是：

```text
container-<name>
```

例如：

```bash
--sandbox=container:mikan-tools
```

会使用：

```text
~/.mikan/vaults/container-mikan-tools/
```

这是 **one container one vault**：

- 不同 container 有不同 vault
- 多个用户如果共享同一个 container，就共享同一个 container vault

限制：

- mikan 只在 `docker exec` 时注入 env
- `docker exec` 不能新增 bind mount
- vault file credential 会被保存，但当前不会自动投影到 container 内的 target path
