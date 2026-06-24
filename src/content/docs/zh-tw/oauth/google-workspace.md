---
title: Google Workspace CLI OAuth 設定
description: 設定 Google Workspace CLI OAuth，讓 mikan 儲存並投影 Google Workspace credentials。
sidebar:
  order: 3
  label: Google Workspace CLI
---

> 注意：mikan 會把 Google authorized_user JSON 存進 vault，並保存 target path metadata。`image` sandbox 會把這類 vault file 自動投影到 container 內的 target path；現有 `container` / `firecracker` runtime 仍不會自動做 file projection。

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

如果你希望後續 runtime 自動把這份 credential file 投影到 `/root/.config/gws/credentials.json`，建議用 `image` sandbox 啟動 mikan：

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

預設 metadata target path 是：

```text
/root/.config/gws/credentials.json
```

## 注意事項

- mikan 使用 web OAuth callback，因此 Google OAuth client 必須是 `Web application`，不是 desktop app。
- 如果 Google 沒有回傳 `refresh_token`，請撤銷既有 consent 後重新 `/login`。mikan 會要求 `access_type=offline` 與 `prompt=consent`，但 Google 仍可能因既有授權而省略 refresh token。
- 若要讓 `gws.json` 自動出現在 `/root/.config/gws/credentials.json`，請使用 `image` sandbox。`container` / `firecracker` 目前仍只會保存 file credential metadata，不會自動投影。
