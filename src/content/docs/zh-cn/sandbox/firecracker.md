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
- 凭证按 office key 标识，与 `image:*` 使用的对话范围 vault key 相同；如果没有匹配的 vault，则不注入环境变量

启动验证要求主机 `PATH` 中存在 `fc-agent` 或 `firecracker`，并会验证配置的主机路径。VM 状态验证是尽力而为，可能只会产生警告。

限制：

- mikan 无法在一个并非由它管理的 VM 中强制执行工作区投影，因此该模式在默认的 `isolated` 门禁策略下会拒绝运行；必须显式选择受信任策略
- SSH 使用 `StrictHostKeyChecking=no`；由于首次连接不会验证主机身份，请保护 VM 网络
- VM 生命周期由你管理
- 工作区挂载由你管理
- 文件凭证会被拒绝，而不是被跳过：如果该对话的 vault 中除 `env` 外还存有任何文件，运行会以 `Sandbox type "firecracker" does not support vault file mounts` 失败。在这里请把凭证保存在 `env` 中。
- 资源限制、idle stop 和 `/pi-sandbox boost` 均不适用
