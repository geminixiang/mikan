---
title: Firecracker sandbox
description: 通过 SSH 进入自行管理的 Firecracker VM 执行 commands 并注入 vault env。
---

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace /home/mikan/workspace
```

完整格式：

```text
firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
```

范例：

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace:root:22 /home/mikan/workspace
```

特性：

- mikan 通过 SSH 进入 VM 执行 command
- VM 内 workspace 预期是 `/workspace`
- vault env 会通过 SSH stdin 注入，避免 secret 出现在宿主机 command line
- vault 选择逻辑：
  1. 直接使用 conversation ID 作为 vault key（例如 `d123`）
  2. 找不到 vault 时不注入 env

限制：

- VM lifecycle 由你管理
- workspace mount 由你管理
- vault file credential 会被保存，但当前不会自动投影到 VM 内的 target path
