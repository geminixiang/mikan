---
title: Container sandbox
description: 使用既有 Docker container 執行 mikan commands，並以 container 名稱分配 vault。
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

- mikan 使用 `docker exec` 在既有 container 中執行 command
- container 內 workspace 預期是 `/workspace`
- 建議建立 container 時加上 `--cap-drop=ALL`、`--security-opt=no-new-privileges` 與 `--pids-limit=1024`，避免 container 內程序取得額外權限並限制 runaway process

## Vault key

Vault key 由 container 名稱推導而來——一段可讀的前綴，加上該名稱的短 digest；因此 `--sandbox=container:mikan-tools` 會使用 `~/.mikan/vaults/mikan-tools-<digest>/`。實際目錄由 mikan 在 `/pi-login` 寫入憑證時產生；在導入 digest 之前寫下的 vault 目錄（`container-<name>`）仍然讀得到。

不論哪一種，語意都是 **one container one vault**：

- 不同 container 有不同 vault
- 多個使用者如果共用同一個 container，就共用同一個 container vault

與以對話為範圍的模式不同，這個 key 不取決於對話，因此 container vault 並不是以對話為單位的憑證邊界。

## Door policy

`container:*` 無法落實以對話為範圍的 workspace projection 或唯讀共享記憶——`docker exec` 無法替一個不是 mikan 建立的 container 新增 mount——因此它會拒絕生效的 isolated projection 與平台推導的 private/唯讀 projection。請在全域 `settings.json` 或 admin portal 中明確選擇 trusted 讀寫 policy（`/pi-sandbox` 聊天指令只服務受管的 sandbox），並在建立 container 時自行掛載 workspace。

## 限制

- mikan 只在 `docker exec` 時注入 env
- `docker exec` 不能新增 bind mount，因此 **file credential 是被拒絕而不是被略過**：如果這個 container 的 vault 中除了 `env` 之外還有任何檔案，執行就會失敗並拋出 `Sandbox type "container" does not support vault file mounts`。在這裡請把憑證放在 `env` 中。
- mikan 不管理這個 container 的 lifecycle、資源限制或 `/pi-sandbox boost`
