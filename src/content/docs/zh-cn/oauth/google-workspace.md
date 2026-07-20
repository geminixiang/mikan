---
title: Google Workspace CLI OAuth 设定
description: 设定 Google Workspace CLI OAuth，让 mikan 储存并投影 Google Workspace credentials。
sidebar:
  order: 3
  label: Google Workspace CLI
---

## 1. 建立 Google OAuth Client

到 Google Cloud Console：

```text
APIs & Services → Credentials → Create Credentials → OAuth client ID
```

设定：

- Application type：`Web application`
- Authorized redirect URI：`<LINK_URL>/oauth/callback`

范例：

```text
LINK_URL=https://mikan.example.com
Redirect URI=https://mikan.example.com/oauth/callback
```

如果 OAuth app 还在 testing mode，请把使用者加入：

```text
OAuth consent screen → Test users
```

## 2. 设定环境变数

```bash
export LINK_URL="https://mikan.example.com"
export GOOGLE_WORKSPACE_CLI_CLIENT_ID="<client-id>"
export GOOGLE_WORKSPACE_CLI_CLIENT_SECRET="<client-secret>"
```

如果没有设定 `LINK_PORT`，mikan 会在 `LINK_URL` 存在时预设监听 `8181`。

可选：覆盖预设 scopes：

```bash
export GOOGLE_WORKSPACE_CLI_OAUTH_SCOPES="https://www.googleapis.com/auth/drive https://mail.google.com/ https://www.googleapis.com/auth/calendar"
```

## 3. 使用 `/login`

如果你希望后续 runtime 自动把这份 credential file 投影到 `/root/.config/gws/credentials.json`，建议用 `image` sandbox 启动 mikan：

```bash
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

在与 bot 的私讯中输入：

```text
/login
```

打开 mikan 回传的 link，选择 Google Workspace CLI OAuth。

成功后，mikan 会把 authorized user credential 存成 vault file，例如：

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "type": "authorized_user"
}
```

预设 metadata target path 是：

```text
/root/.config/gws/credentials.json
```

## 注意事项

- mikan 使用 web OAuth callback，因此 Google OAuth client 必须是 `Web application`，不是 desktop app。
- 如果 Google 没有回传 `refresh_token`，请撤销既有 consent 后重新 `/login`。mikan 会要求 `access_type=offline` 与 `prompt=consent`，但 Google 仍可能因既有授权而省略 refresh token。
