---
title: Vault
description: mikan 如何把 credentials 存在 state directory，并依 sandbox 模式注入 env 或 file mounts。
---

## State directory 与 vault 位置

state directory 预设是：

```text
~/.mikan/
```

其中重要内容包含：

```text
~/.mikan/
├── settings.json
└── vaults/
    └── <vault-id>/
```

也可以用 `--state-dir` 指定：

```bash
mikan --state-dir=/secure/mikan-state --sandbox=container:mikan-tools /path/to/workspace
```

此时 credential 会存在：

```text
/secure/mikan-state/vaults/
```

全域设定档位于 `<state-dir>/settings.json`。Conversation-local 设定位于 `<working-directory>/<conversationId>/settings.json`，用来覆盖该 conversation 的全域预设。

启动时 mikan 会拒绝使用 world-writable 或非目前使用者拥有的 `--state-dir`，避免本机其他使用者窜改 settings 或 vault 内容。

## Vault 内容

每个 vault 是 `vaults/` 下的一个目录，里面可包含：

- `env` file：`KEY=value` 形式的环境变数
- file credentials：例如 `gws.json`、`.ssh/config`

mikan 会从档名/路径自动推断 mount target，例如 `gws.json` → `/root/.config/gws/credentials.json`、`.ssh/` → `/root/.ssh`。

范例：

```text
~/.mikan/vaults/
└── container-mikan-tools/
    ├── env
    └── gws.json
```

`env` 范例：

```env
GH_TOKEN=ghp_xxx
GITHUB_OAUTH_ACCESS_TOKEN=gho_xxx
```

## Sandbox 行为

| Sandbox mode       | Vault env injection | File credential projection | Vault key                                            |
| ------------------ | ------------------- | -------------------------- | ---------------------------------------------------- |
| `host`             | 不注入              | 不投影                     | 可存 credentials，但不注入 host commands             |
| `container:<name>` | 注入                | 不投影                     | `container-<name>`                                   |
| `image:<image>`    | 注入                | 自动投影                   | generated conversation vault，通常是 conversation ID |
| `firecracker:*`    | 注入                | 不投影                     | generated conversation vault                         |
| `cloudflare:*`     | 注入                | 不投影                     | generated platform-scoped conversation vault         |

## `/login`

使用者在 DM / 私讯中执行：

```text
/login
```

mikan 会产生一个 15 分钟有效的 onboarding link。使用者可在网页中储存：

- 任意 API key / env var
- GitHub OAuth credential
- Google Workspace CLI OAuth credential

`/login` 只能在 DM / 私讯使用，避免共享频道中的其他人取得 credential onboarding link。

## 启用 link server

正式部署时，设定公开 URL：

```bash
export LINK_URL="https://mikan.example.com"
```

若没有设定 `LINK_PORT`，mikan 会在 `LINK_URL` 存在时预设使用 port `8181`。

也可以明确指定：

```bash
export LINK_PORT=8181
```

若只是本机测试，也可以只设：

```bash
export LINK_PORT=8181
```

此时 `/login` link 会使用：

```text
http://localhost:8181
```

OAuth callback URL 是：

```text
<LINK_URL>/oauth/callback
```
