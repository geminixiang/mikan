---
title: Vault
description: mikan 如何在 state directory 中存储凭证，并按沙箱模式注入环境变量或文件挂载。
---

## State directory 和 vault 位置

默认 state directory 为：

```text
~/.mikan/
```

重要内容包括：

```text
~/.mikan/
├── settings.json
└── vaults/
    └── <vault-id>/
```

也可以使用 `--state-dir` 指定：

```bash
mikan --state-dir=/secure/mikan-state --sandbox=container:mikan-tools /path/to/workspace
```

凭证随后存储在：

```text
/secure/mikan-state/vaults/
```

全局设置文件位于 `<state-dir>/settings.json`。对话覆盖位于仅主机可见的 `<state-dir>/conversations/<conversationId>/settings.json`。旧版 `<working-directory>/<conversationId>/settings.json` 会迁移一次，之后被忽略。

启动时，mikan 会拒绝全局可写或不归当前用户所有的 `--state-dir`。新创建的 state/vault 目录和凭证文件使用私有模式，但现有的组/全局可读 state directory 不会自动收紧权限；请使用 `chmod 0700 <state-dir>`。

## Vault 内容

每个 vault 都是 `vaults/` 下的目录，可以包含：

- `env` 文件：`KEY=value` 形式的环境变量
- 文件凭证：例如 `gws.json`、`.ssh/config`

mikan 根据文件名/路径推断挂载目标，例如 `gws.json` → `/root/.config/gws/credentials.json`，`.ssh/` → `/root/.ssh`。在 image 模式下，这些凭证挂载可以从沙箱内写入，因此工具可能会更新它们；请备份不应被修改的凭证。

示例：

```text
~/.mikan/vaults/
└── container-mikan-tools/
    ├── env
    └── gws.json
```

`env` 示例：

```env
GH_TOKEN=ghp_xxx
GITHUB_OAUTH_ACCESS_TOKEN=gho_xxx
```

## 沙箱行为

| 沙箱模式           | Vault 环境变量注入 | 文件凭证投射 | Vault key                        |
| ------------------ | ------------------ | ------------ | -------------------------------- |
| `host`             | 不注入             | 不投射       | 可以存储凭证，但不会注入主机命令 |
| `container:<name>` | 注入               | 不投射       | `container-<name>`               |
| `image:<image>`    | 注入               | 自动投射     | 生成的对话 vault，通常为对话 ID  |
| `firecracker:*`    | 注入               | 不投射       | 生成的对话 vault                 |
| `cloudflare:*`     | 注入               | 不投射       | 生成的平台范围对话 vault         |

## `/login`

在 DM / 私聊中运行：

```text
/login
```

mikan 会创建一个有效期 15 分钟的引导链接。用户可以在网页中存储：

- 任意 API key / 环境变量
- GitHub OAuth 凭证
- Google Workspace CLI OAuth 凭证

`/login` 仅在 DM / 私聊中有效，因此共享频道中的其他人无法获取凭证引导链接。

## 启用链接服务器

对于生产部署，请设置公开 URL：

```bash
export LINK_URL="https://mikan.example.com"
```

如果未设置 `LINK_PORT`，当 `LINK_URL` 存在时，mikan 默认使用端口 `8181`。

也可以显式设置：

```bash
export LINK_PORT=8181
```

本地测试时，可以只设置：

```bash
export LINK_PORT=8181
```

此时 `/login` 链接会使用：

```text
http://localhost:8181
```

OAuth 回调 URL 为：

```text
<LINK_URL>/oauth/callback
```
