---
title: Firecracker sandbox
description: 透過 SSH 進入自行管理的 Firecracker VM 執行 commands 並注入 vault env。
---

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace /home/mikan/workspace
```

完整格式：

```text
firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
```

範例：

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace:root:22 /home/mikan/workspace
```

特性：

- mikan 透過 SSH 進 VM 執行 command
- VM 內 workspace 預期是 `/workspace`
- vault env 會透過 SSH stdin 注入，避免 secret 出現在宿主機 command line
- vault 選擇會將 conversation ID 正規化為小寫，並將連續的非英數字元替換為 `-`；若找不到相符 vault，就不注入 env

啟動驗證要求 host `PATH` 中存在 `fc-agent` 或 `firecracker`，並驗證設定的 host path。VM 狀態驗證是 best-effort，可能只產生 warning。

限制：

- SSH 使用 `StrictHostKeyChecking=no`；請保護 VM network，因為首次連線時不會驗證 host identity
- VM lifecycle 由你管理
- workspace mount 由你管理
- vault file credential 會被保存，但目前不會自動投影到 VM 內的 target path
