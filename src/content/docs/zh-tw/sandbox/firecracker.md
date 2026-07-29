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
- credentials 以 office key 為 key，也就是 `image:*` 使用的那個以對話為範圍的 vault key；若找不到相符 vault，就不注入 env

啟動驗證要求 host `PATH` 中存在 `fc-agent` 或 `firecracker`，並驗證設定的 host path。VM 狀態驗證是 best-effort，可能只產生 warning。

限制：

- mikan 無法在一個不由它管理的 VM 中落實 workspace projection，因此這個模式會拒絕在預設的 `isolated` door policy 下執行；必須明確選擇 trusted policy
- SSH 使用 `StrictHostKeyChecking=no`；請保護 VM network，因為首次連線時不會驗證 host identity
- VM lifecycle 由你管理
- workspace mount 由你管理
- file credential 是被拒絕而不是被略過：如果該對話的 vault 中除了 `env` 之外還有任何檔案，執行就會失敗並拋出 `Sandbox type "firecracker" does not support vault file mounts`。在這裡請把憑證放在 `env` 中。
- 資源限制、idle stop 與 `/pi-sandbox boost` 都不適用
