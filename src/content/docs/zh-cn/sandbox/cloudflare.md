---
title: Cloudflare sandbox
description: 使用自行部署的 Cloudflare Worker bridge 执行 experimental Cloudflare sandbox。
---

```bash
export CLOUDFLARE_SANDBOX_URL="https://your-bridge.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="replace-me" # optional

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

特性：

- mikan 会把 remote sandbox id 衍生为 `<base-sandbox-id>-<vault-key>`
- vault env 会在每次 `exec()` 时通过 bridge 注入
- vault 选择逻辑和 `image` 类似：使用 conversation ID 生成 platform-scoped vault key

限制：

- 远端 `/workspace` 不会自动 mirror 本地工作目录
- 因此 `pwd` 会显示 `/workspace`，但 `ls` 可能是空的；这是预期行为，不代表它正在读取你的本机 repo
- vault file credential 当前不会自动投影到 Cloudflare sandbox
- 需要自行部署 bridge Worker 与对应 container image

可直接使用范例 bridge：

- [examples/cloudflare-sandbox-bridge/README.md](../../examples/cloudflare-sandbox-bridge/README.md)
