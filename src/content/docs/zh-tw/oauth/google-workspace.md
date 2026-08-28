---
title: Google Workspace CLI OAuth 設定
description: 設定 Google Workspace CLI OAuth，讓 mikan 儲存並投影 Google Workspace credentials。
sidebar:
  order: 3
  label: Google Workspace CLI
---

## 1. 建立 Google OAuth Client

到 Google Cloud Console：

```text
APIs & Services → Credentials → Create Credentials → OAuth client ID
```

設定：

- Application type：`Web application`
- Authorized redirect URI：`<LINK_URL>/oauth/callback`

範例：

```text
LINK_URL=https://mikan.example.com
Redirect URI=https://mikan.example.com/oauth/callback
```

如果 OAuth app 還在 testing mode，請把使用者加入：

```text
OAuth consent screen → Test users
```

## 2. 設定環境變數

```bash
export LINK_URL="https://mikan.example.com"
export GOOGLE_WORKSPACE_CLI_CLIENT_ID="<client-id>"
export GOOGLE_WORKSPACE_CLI_CLIENT_SECRET="<client-secret>"
```

如果沒有設定 `LINK_PORT`，mikan 會在 `LINK_URL` 存在時預設監聽 `8181`。

可選：覆蓋預設 scopes：

```bash
export GOOGLE_WORKSPACE_CLI_OAUTH_SCOPES="https://www.googleapis.com/auth/drive https://mail.google.com/ https://www.googleapis.com/auth/calendar"
```

## 3. 使用 `/login`

```bash
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

在與 bot 的私訊中輸入：

```text
/login
```

打開 mikan 回傳的 link，選擇 Google Workspace CLI OAuth。

成功後，mikan 會把 authorized user credential 存成 vault file，例如：

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "type": "authorized_user"
}
```

從 `gws.json` 這個名稱推斷出的 target path 是：

```text
/root/.config/gws/credentials.json
```

## 注意事項

- mikan 使用 web OAuth callback，因此 Google OAuth client 必須是 `Web application`，不是 desktop app。
- 如果 Google 沒有回傳 `refresh_token`，請撤銷既有 consent 後重新 `/login`。mikan 會要求 `access_type=offline` 與 `prompt=consent`，但 Google 仍可能因既有授權而省略 refresh token。
