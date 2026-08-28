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
├── conversations/
│   └── <office-key>/
│       └── settings.json
└── vaults/
    ├── <office-key>/          # one conversation's credentials
    ├── shared/<name>/         # shared login profiles
    └── extensions/<slug>/     # extension secrets (host-side only)
```

也可以使用 `--state-dir` 指定：

```bash
mikan --state-dir=/secure/mikan-state --sandbox=container:mikan-tools /path/to/workspace
```

凭证随后存储在：

```text
/secure/mikan-state/vaults/
```

全局设置文件位于 `<state-dir>/settings.json`。对话覆盖位于仅主机可见的 `<state-dir>/conversations/<office-key>/settings.json`。旧版 `<working-directory>/<conversationId>/settings.json` 会迁移一次，之后被忽略——对话目录会以可读写方式挂载进沙箱，因此设置有意存放在它们之外。

启动时，mikan 会拒绝全局可写或不归当前用户所有的 `--state-dir`。新创建的 state/vault 目录和凭证文件使用私有模式，但现有的组/全局可读 state directory 不会自动收紧权限；请使用 `chmod 0700 <state-dir>`。

## Vault 内容

每个 vault 都是 `vaults/` 下的目录，可以包含：

- `env` 文件：`KEY=value` 形式的环境变量
- 文件凭证：例如 `gws.json`、`.ssh/config`

mikan 根据文件名/路径推断挂载目标——`gws.json` → `/root/.config/gws/credentials.json`，`gcloud-adc.json` → `/root/.config/gcloud/application_default_credentials.json`，`.ssh/` → `/root/.ssh`，`.kube/` → `/root/.kube`，`.config/gh/` → `/root/.config/gh`——其余一律默认为 `/root/<relative-path>`。每次解析 vault 时都会从文件名重新派生目标；它不会作为 metadata 存储，因此重命名凭证文件会改变它的落点。内置的 OAuth 流程会选用本身就能推断到正确位置的名称，并把对应的环境变量（例如 `GOOGLE_APPLICATION_CREDENTIALS`）指向它。

示例：

```text
~/.mikan/vaults/
└── v1-slack-c0123456789-1a2b3c4d5e6f7a8b/
    ├── env
    └── gws.json
```

`env` 示例：

```env
GH_TOKEN=ghp_xxx
GITHUB_OAUTH_ACCESS_TOKEN=gho_xxx
```

## 哪些内容会进入沙箱

Vault 中的材料并不是同一类无差别的 secret：

- **对话自己的 vault 本就应该进入 guest。** 它的 `env` 条目会成为工具命令的环境变量，它的凭证文件会被投影到各自的目标路径（默认位于 `/root` 下）。这正是它的意义所在：代理以登录者本人的身份运行 `gh`、`gcloud` 或 `ssh`。
- **vault 目录本身绝不会被整体挂载。** 只有已解析的 vault 所声明的单个凭证文件会被投影，每个文件一个 mount，而且只针对该 key 所解析到的那个对话。
- **Daemon token 绝不会进入 guest。** 平台 bot token（`SLACK_BOT_TOKEN`、GitHub App private key 等）由 mikan 主机进程读取，不属于任何 vault 注入。
- **扩展 secret 绝不会进入 guest。** `vaults/extensions/<slug>/env` 通过扩展 API 在主机侧读取；它不是用户 vault，不会被挂载或注入。

这是数据边界，而不是执行边界。凡是该对话自己的凭证能做的事，它的代理都能做——请据此限定你所存储的凭证权限范围。

## 沙箱行为

| 沙箱模式           | Vault 环境变量注入 | 文件凭证           | Vault key             |
| ------------------ | ------------------ | ------------------ | --------------------- |
| `host`             | 不注入             | 拒绝               | 由平台用户派生        |
| `container:<name>` | 注入               | 拒绝               | 由 container 名称派生 |
| `image:<image>`    | 注入               | 投影（bind mount） | office key            |
| `cloudflare:*`     | 注入               | 拒绝               | office key            |

**拒绝意味着运行会失败，而不是该文件被悄悄忽略。** vault 目录中只要存有 `env` 以外的任何文件，就会解析出一个文件 mount，而无法 mount 文件的模式会抛出 `Sandbox type "<type>" does not support vault file mounts`，而不是带着不完整的凭证集合运行。因此在这些模式上，请只用 `env` 保存凭证——早先 `image` 部署遗留在 vault 中的一个多余 `gws.json`，就会让该对话无法运行。

office key 由平台名称与平台的原始对话 id 一起哈希派生，因此两个共用同一原始 id 的平台无法解析到彼此的凭证。在旧的原始 id 方案下创建的对话 vault 目录，会由启动时的迁移重命名为 office key；若发生冲突（两个目录同时存在），启动会停止以便手动合并，而不是自行选一个。

## 共享 vault

`sandbox.defaultSharedVault` 指定 `vaults/shared/` 下的一个配置文件，它会在新对话首次使用时被复制进该对话的 vault。这种环境复制只发生在基于成员身份把关的平台（Slack、Discord、Telegram）上，且仅限隔离的 `image` 和 `cloudflare` 拓扑。GitHub 这类开放触发面绝不会继承它——管理员仍然可以为某个特定的 GitHub 对话显式配置 vault。

## `/pi-login`

在 DM / 私聊中运行：

```text
/pi-login
```

`/login` 会作为同一个命令被接受；Slack 注册的是 `/pi-` 拼写。

mikan 会创建一个有效期 15 分钟的引导链接。用户可以在网页中存储：

- 任意 API key / 环境变量
- GitHub OAuth 凭证
- Google Cloud SDK OAuth 凭证
- Google Workspace CLI OAuth 凭证

该命令仅在 DM / 私聊中有效，因此共享频道中的其他人无法获取凭证引导链接。该链接是一个 bearer capability，凭证写入或 OAuth 回调完成后即被消耗——参阅 [Portal 身份验证和 capability 模型](/zh-cn/portal-auth-model/)。

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
