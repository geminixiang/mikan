---
title: GitHub OAuth 设定
description: 建立 GitHub OAuth App，让 mikan 的 /login 储存并注入 GitHub credentials。
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

范例：

```text
LINK_URL=https://mikan.example.com
Callback URL=https://mikan.example.com/oauth/callback
```

## 2. 设定环境变数

```bash
export LINK_URL="https://mikan.example.com"
export GITHUB_OAUTH_CLIENT_ID="<client-id>"
export GITHUB_OAUTH_CLIENT_SECRET="<client-secret>"
```

如果没有设定 `LINK_PORT`，mikan 会在 `LINK_URL` 存在时预设监听 `8181`。

## 3. 启动 mikan

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

在与 bot 的私讯中输入：

```text
/login
```

打开 mikan 回传的 link，选择 GitHub OAuth。

成功后，mikan 会把 token 写入对应 vault 的 `env`，包含：

```text
GITHUB_OAUTH_ACCESS_TOKEN
GH_TOKEN
```

在 `container` / `image` / `firecracker` sandbox 中，后续工具执行会注入这些 env。

## Scopes

预设 GitHub OAuth scopes：

```text
repo read:user user:email read:org gist
```

可用环境变数覆盖：

```bash
export GITHUB_OAUTH_SCOPES="repo read:user user:email read:org gist workflow"
```

请只加入你真的需要的 scopes。较高权限 scopes 会增加 credential 外泄时的风险。
