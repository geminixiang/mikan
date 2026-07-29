---
title: Cloudflare 沙箱
description: 通过自行部署的 Cloudflare Worker 桥接器运行实验性 Cloudflare 沙箱。
---

```bash
export CLOUDFLARE_SANDBOX_URL="https://your-bridge.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="replace-me" # optional

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

特性：

- 运行时命令默认使用 `/workspace`；可通过 `CLOUDFLARE_SANDBOX_CWD` 覆盖
- mikan 将远程沙箱 ID 生成为 `<base-sandbox-id>-<vault-key>`
- vault 环境变量在每次 `exec()` 时通过桥接器注入
- vault 选择逻辑与 `image` 类似：根据对话 ID 生成平台范围的 vault key

限制：

- 远程 `/workspace` 不会自动镜像本地工作目录
- 因此 `pwd` 会显示 `/workspace`，但 `ls` 可能为空；这是预期行为，不表示它正在读取本地仓库
- vault 文件凭证目前不会自动投射到 Cloudflare 沙箱
- 你必须自行部署桥接 Worker 和对应的容器镜像

可以直接使用示例桥接器：

- [GitHub 上的 Cloudflare 沙箱桥接示例](https://github.com/geminixiang/mikan/tree/main/deploy/examples/cloudflare-sandbox-bridge)
