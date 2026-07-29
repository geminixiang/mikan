---
title: Cloudflare 沙箱
description: 通过自行部署的 Cloudflare Worker 桥接器运行建设中的 Cloudflare 沙箱。
---

:::caution[建设中]
Cloudflare 模式存在于 mikan 的沙箱配置中，但它并不是一个完成的部署目标：它没有受管理的工作区投影，
没有文件凭证投影，也没有生命周期或资源管理。由于它无法强制执行工作区投影，在默认的 `isolated`
门禁策略下它根本不会运行——必须先显式设置受信任策略。预计它日后会以外包执行界面的形式回归。
任何正式用途请使用 [`image:<image>`](/zh-cn/sandbox/image/)。
:::

```bash
export CLOUDFLARE_SANDBOX_URL="https://your-bridge.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="replace-me" # optional

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

特性：

- 运行时命令默认使用 `/workspace`；可通过 `CLOUDFLARE_SANDBOX_CWD` 覆盖
- mikan 将远程沙箱 ID 生成为 `<base-sandbox-id>-<resource-key>`，因此每个对话在桥接器上寻址自己的沙箱
- vault 环境变量在每次 `exec()` 时通过桥接器注入
- 凭证按 office key 标识，与 `image:*` 使用的对话范围 vault key 相同

限制：

- mikan 在这里无法强制执行工作区投影，因此该模式在默认的 `isolated` 门禁策略下会拒绝运行；必须显式选择受信任策略
- 远程 `/workspace` 不会自动镜像本地工作目录
- 因此 `pwd` 会显示 `/workspace`，但 `ls` 可能为空；这是预期行为，不表示它正在读取本地仓库
- 文件凭证会被拒绝，而不是被跳过：如果该对话的 vault 中除 `env` 外还存有任何文件，运行会以 `Sandbox type "cloudflare" does not support vault file mounts` 失败。在这里请把凭证保存在 `env` 中。
- 容器生命周期、idle stop、资源限制和 `/pi-sandbox boost` 均不适用
- 你必须自行部署桥接 Worker 和对应的容器镜像

可以直接使用示例桥接器：

- [GitHub 上的 Cloudflare 沙箱桥接示例](https://github.com/geminixiang/mikan/tree/main/deploy/examples/cloudflare-sandbox-bridge)
