---
title: Firecracker 沙箱
description: 通过 SSH 进入自行管理的 Firecracker VM 执行命令并注入 vault 环境变量。
---

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace /home/mikan/workspace
```

完整格式：

```text
firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
```

示例：

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace:root:22 /home/mikan/workspace
```

特性：

- mikan 通过 SSH 在 VM 中运行命令
- VM 内的工作区应位于 `/workspace`
- vault 环境变量通过 SSH stdin 注入，因此机密不会出现在主机命令行中
- vault 选择会将对话 ID 转为小写，并把连续的非字母数字字符替换为 `-`；如果没有匹配的 vault，则不注入环境变量

启动验证要求主机 `PATH` 中存在 `fc-agent` 或 `firecracker`，并会验证配置的主机路径。VM 状态验证是尽力而为，可能只会产生警告。

限制：

- SSH 使用 `StrictHostKeyChecking=no`；由于首次连接不会验证主机身份，请保护 VM 网络
- VM 生命周期由你管理
- 工作区挂载由你管理
- vault 文件凭证会被保存，但目前不会自动投射到 VM 内的目标路径
