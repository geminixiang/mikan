---
title: GitHub OAuth Setup
---

# GitHub OAuth Setup

這份文件說明如何設定 mikan `/login` 內建的 GitHub OAuth。

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

在 `container` / `image` / `firecracker` sandbox 中，後續工具執行會注入這些 env。

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
