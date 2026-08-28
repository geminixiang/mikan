---
title: Cloudflare sandbox
description: 使用自行部署的 Cloudflare Worker bridge 執行施工中的 Cloudflare sandbox。
---

:::caution[施工中]
Cloudflare 模式雖然存在於 mikan 的 sandbox 設定中，但它並不是一個完成的部署目標：它沒有受管的 workspace projection、沒有 file-credential projection，也沒有 lifecycle 或資源管理。由於它無法落實 isolated projection 或唯讀共享記憶，必須先明確設定 trusted 讀寫 policy。預期它日後會以「外包執行介面」的形式回歸。任何實際用途請改用 [`image:<image>`](/zh-tw/sandbox/image/)。
:::

```bash
export CLOUDFLARE_SANDBOX_URL="https://your-bridge.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="replace-me" # optional

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

特性：

- runtime commands 使用 `/workspace`
- mikan 會把 remote sandbox id 衍生為 `<base-sandbox-id>-<resource-key>`，因此每個對話在 bridge 上都對應到自己的 sandbox
- vault env 會在每次 `exec()` 時透過 bridge 注入
- credentials 以 office key 為 key，也就是 `image:*` 使用的那個以對話為範圍的 vault key

限制：

- mikan 在這裡無法落實 isolated workspace projection 或唯讀共享記憶；必須明確選擇 trusted 讀寫 policy
- 遠端 `/workspace` 不會自動 mirror 本機工作目錄
- 因此 `pwd` 會顯示 `/workspace`，但 `ls` 可能是空的；這是預期行為，不代表它正在讀你的本機 repo
- file credential 是被拒絕而不是被略過：如果該對話的 vault 中除了 `env` 之外還有任何檔案，執行就會失敗並拋出 `Sandbox type "cloudflare" does not support vault file mounts`。在這裡請把憑證放在 `env` 中。
- container lifecycle、idle stop、資源限制與 `/pi-sandbox boost` 都不適用
- 需要自行部署 bridge Worker 與對應 container image

可直接使用範例 bridge：

- [GitHub 上的 Cloudflare sandbox bridge 範例](https://github.com/geminixiang/mikan/tree/main/deploy/examples/cloudflare-sandbox-bridge)
