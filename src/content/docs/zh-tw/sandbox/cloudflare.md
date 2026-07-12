---
title: Cloudflare sandbox
description: 使用自行部署的 Cloudflare Worker bridge 執行 experimental Cloudflare sandbox。
---

```bash
export CLOUDFLARE_SANDBOX_URL="https://your-bridge.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="replace-me" # optional

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

特性：

- runtime commands 預設使用 `/workspace`；可用 `CLOUDFLARE_SANDBOX_CWD` 覆寫
- mikan 會把 remote sandbox id 衍生為 `<base-sandbox-id>-<vault-key>`
- vault env 會在每次 `exec()` 時透過 bridge 注入
- vault 選擇邏輯和 `image` 類似：使用 conversation ID 產生 platform-scoped vault key

限制：

- 遠端 `/workspace` 不會自動 mirror 本機工作目錄
- 因此 `pwd` 會顯示 `/workspace`，但 `ls` 可能是空的；這是預期行為，不代表它正在讀你的本機 repo
- vault file credential 目前不會自動投影到 Cloudflare sandbox
- 需要自行部署 bridge Worker 與對應 container image

可直接使用範例 bridge：

- [GitHub 上的 Cloudflare sandbox bridge 範例](https://github.com/geminixiang/mikan/tree/main/examples/cloudflare-sandbox-bridge)
