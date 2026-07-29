---
title: GitHub OAuth 設定
description: 建立 GitHub OAuth App，讓 mikan 的 /login 儲存並注入 GitHub credentials。
sidebar:
  order: 1
  label: GitHub
---

## 1. 建立 GitHub OAuth App

到 GitHub：

```text
Settings → Developer settings → OAuth Apps → New OAuth App
```

填入：

- Application name：例如 `mikan`
- Homepage URL：你的 `LINK_URL`
- Authorization callback URL：`<LINK_URL>/oauth/callback`

範例：

```text
LINK_URL=https://mikan.example.com
Callback URL=https://mikan.example.com/oauth/callback
```

## 2. 設定環境變數

```bash
export LINK_URL="https://mikan.example.com"
export GITHUB_OAUTH_CLIENT_ID="<client-id>"
export GITHUB_OAUTH_CLIENT_SECRET="<client-secret>"
```

如果沒有設定 `LINK_PORT`，mikan 會在 `LINK_URL` 存在時預設監聽 `8181`。

## 3. 啟動 mikan

```bash
mikan --sandbox=container:mikan-tools /path/to/workspace
```

或使用 managed per-user container：

```bash
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

或：

```bash
mikan --sandbox=firecracker:192.168.1.100:/path/to/workspace /path/to/workspace
```

## 4. 使用 `/login`

在與 bot 的私訊中輸入：

```text
/login
```

打開 mikan 回傳的 link，選擇 GitHub OAuth。

成功後，mikan 會把 token 寫入對應 vault 的 `env`，包含：

```text
GITHUB_OAUTH_ACCESS_TOKEN
GH_TOKEN
```

除了 `host` 之外的每一種 sandbox 模式，都會在後續工具執行時注入這些 env。

這些是登入者本人的憑證，而且它們本來就該進到 sandbox——agent 是以那個人的身分執行 `gh` 與 `git`。請注意這與 [GitHub 接入](/zh-tw/platform-adapters/github/)所使用的 mikan 自身 GitHub App 身分是分開的；後者的 token 只留在 host 端，絕不會進入 runtime。

## Scopes

預設 GitHub OAuth scopes：

```text
repo read:user user:email read:org gist
```

可用環境變數覆蓋：

```bash
export GITHUB_OAUTH_SCOPES="repo read:user user:email read:org gist workflow"
```

請只加入你真的需要的 scopes。較高權限 scopes 會增加 credential 外洩時的風險。
