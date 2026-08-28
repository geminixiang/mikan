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

## Vault key

vault key 由 container 名称派生——一个可读前缀加上该名称的短摘要，因此 `--sandbox=container:mikan-tools`
使用 `~/.mikan/vaults/mikan-tools-<digest>/`。当 `/pi-login` 写入 credential 时，mikan 会生成确切的目录；
在引入摘要之前写入的 vault 目录（`container-<name>`）仍可读取。

无论哪种方式，语义都是 **one container one vault**：

- 不同 container 有不同 vault
- 多个用户如果共享同一个 container，就共享同一个 container vault

与对话范围的模式不同，这里的 key 不依赖对话，因此 container vault 并不是按对话的凭证边界。

## 门禁策略

`container:*` 无法强制执行对话范围的工作区投影或只读共享记忆——`docker exec` 无法为一个并非由 mikan 创建的 container
添加 mount——因此它会拒绝生效的 isolated 投影和平台推导出的 private/只读投影。请在全局 `settings.json` 或 admin portal
中显式选择受信任的读写策略（`/pi-sandbox` 聊天命令只服务于受管理的沙箱），并在创建 container 时自行挂载工作区。

## 限制

- mikan 只在 `docker exec` 时注入 env
- `docker exec` 不能新增 bind mount，因此**文件凭证会被拒绝，而不是被跳过**：如果该 container 的 vault 中除 `env` 外还存有任何文件，运行会以 `Sandbox type "container" does not support vault file mounts` 失败。在这里请把凭证保存在 `env` 中。
- mikan 不管理该 container 的生命周期、资源限制或 `/pi-sandbox boost`
