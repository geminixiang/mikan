---
title: Container sandbox
---

# Container sandbox

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

- mikan 使用 `docker exec` 在既有 container 中執行 command
- container 內 workspace 預期是 `/workspace`
- 建議建立 container 時加上 `--cap-drop=ALL`、`--security-opt=no-new-privileges` 與 `--pids-limit=1024`，避免 container 內程序取得額外權限並限制 runaway process
- vault key 是：

```text
container-<name>
```

例如：

```bash
--sandbox=container:mikan-tools
```

會使用：

```text
~/.mikan/vaults/container-mikan-tools/
```

這是 **one container one vault**：

- 不同 container 有不同 vault
- 多個使用者如果共用同一個 container，就共用同一個 container vault

限制：

- mikan 只在 `docker exec` 時注入 env
- `docker exec` 不能新增 bind mount
- vault file credential 會被保存，但目前不會自動投影到 container 內的 target path
