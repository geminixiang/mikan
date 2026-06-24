---
title: Vault
description: mikan 如何把 credentials 存在 state directory，並依 sandbox 模式注入 env 或 file mounts。
---

## State directory 與 vault 位置

state directory 預設是：

```text
~/.mikan/
```

其中重要內容包含：

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

此時 credential 會存在：

```text
/secure/mikan-state/vaults/
```

全域設定檔位於 `<state-dir>/settings.json`。Conversation-local 設定位於 `<working-directory>/<conversationId>/settings.json`，用來覆蓋該 conversation 的全域預設。

啟動時 mikan 會拒絕使用 world-writable 或非目前使用者擁有的 `--state-dir`，避免本機其他使用者竄改 settings 或 vault 內容。

## Vault 內容

每個 vault 是 `vaults/` 下的一個目錄，裡面可包含：

- `env` file：`KEY=value` 形式的環境變數
- file credentials：例如 `gws.json`、`.ssh/config`

mikan 會從檔名/路徑自動推斷 mount target，例如 `gws.json` → `/root/.config/gws/credentials.json`、`.ssh/` → `/root/.ssh`。

範例：

```text
~/.mikan/vaults/
└── container-mikan-tools/
    ├── env
    └── gws.json
```

`env` 範例：

```env
GH_TOKEN=ghp_xxx
GITHUB_OAUTH_ACCESS_TOKEN=gho_xxx
```

## Sandbox 行為

| Sandbox mode       | Vault env injection | File credential projection | Vault key                                            |
| ------------------ | ------------------- | -------------------------- | ---------------------------------------------------- |
| `host`             | 不注入              | 不投影                     | 可存 credentials，但不注入 host commands             |
| `container:<name>` | 注入                | 不投影                     | `container-<name>`                                   |
| `image:<image>`    | 注入                | 自動投影                   | generated conversation vault，通常是 conversation ID |
| `firecracker:*`    | 注入                | 不投影                     | generated conversation vault                         |
| `cloudflare:*`     | 注入                | 不投影                     | generated platform-scoped conversation vault         |

## `/login`

使用者在 DM / 私訊中執行：

```text
/login
```

mikan 會產生一個 15 分鐘有效的 onboarding link。使用者可在網頁中儲存：

- 任意 API key / env var
- GitHub OAuth credential
- Google Workspace CLI OAuth credential

`/login` 只能在 DM / 私訊使用，避免共享頻道中的其他人取得 credential onboarding link。

## 啟用 link server

正式部署時，設定公開 URL：

```bash
export LINK_URL="https://mikan.example.com"
```

若沒有設定 `LINK_PORT`，mikan 會在 `LINK_URL` 存在時預設使用 port `8181`。

也可以明確指定：

```bash
export LINK_PORT=8181
```

若只是本機測試，也可以只設：

```bash
export LINK_PORT=8181
```

此時 `/login` link 會使用：

```text
http://localhost:8181
```

OAuth callback URL 是：

```text
<LINK_URL>/oauth/callback
```
