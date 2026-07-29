---
title: Google Cloud SDK OAuth 設定
description: 設定 Google Cloud SDK OAuth，讓 sandbox 內的 gcloud 使用登入後的 user credential。
sidebar:
  order: 2
  label: Google Cloud SDK
---

> 注意：mikan 會把 Google `authorized_user` JSON 以 `gcloud-adc.json` 的名稱存進 vault，而 runtime 的 target 是從這個檔名推斷出來的。`image` 與 `gondolin` sandbox 會自動把該檔案投影到 runtime 內的那個 target。`container`、`firecracker` 與 `cloudflare` 完全無法掛載檔案，而且會讓執行失敗，而不是在缺少該憑證的情況下繼續，因此請不要在那些模式上使用這個流程。

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
export GOOGLE_CLOUD_SDK_CLIENT_ID="<client-id>"
export GOOGLE_CLOUD_SDK_CLIENT_SECRET="<client-secret>"
```

如果沒有設定 `LINK_PORT`，mikan 會在 `LINK_URL` 存在時預設監聽 `8181`。

可選：覆蓋預設 scopes：

```bash
export GOOGLE_CLOUD_SDK_OAUTH_SCOPES="openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform"
```

## 3. 使用 `/pi-login`

如果你希望後續 runtime 自動把 credential file 投影到 `/root/.config/gcloud/application_default_credentials.json`，建議用 `image` sandbox（或 `gondolin:default`）啟動 mikan：

```bash
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

在與 bot 的私訊中輸入：

```text
/pi-login
```

打開 mikan 回傳的 link，選擇 **Google Cloud SDK (gcloud)**。

成功後，mikan 會：

- 存入 vault file：`gcloud-adc.json`
- 在 sandbox 投影到：`/root/.config/gcloud/application_default_credentials.json`
- 設定 env：
  - `GOOGLE_APPLICATION_CREDENTIALS=/root/.config/gcloud/application_default_credentials.json`
  - `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=/root/.config/gcloud/application_default_credentials.json`

`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` 會讓 `gcloud` 優先使用這份 credential file。

## 注意事項

- mikan 使用 web OAuth callback，因此 Google OAuth client 必須是 `Web application`，不是 desktop app。
- 如果 Google 沒有回傳 `refresh_token`，請撤銷既有 consent 後重新 `/pi-login`。mikan 會要求 `access_type=offline` 與 `prompt=consent`，但 Google 仍可能因既有授權而省略 refresh token。
- 若要讓 credential file 自動出現在 `/root/.config/gcloud/application_default_credentials.json`，請使用 `image` 或 `gondolin` sandbox。在 `container`、`firecracker` 與 `cloudflare` 上，vault 中的 file credential 會讓執行失敗並回報 `does not support vault file mounts`——請移除它，並在那些模式上改用僅含 `env` 的憑證。
- 在 `gondolin:default` 中，該檔案是以僅擁有者可存取的權限複製進 guest，而不是 bind mount；在 host 端輪替它會讓該對話下一次執行指令時重建 runtime，因此 guest 絕不會留著過期的副本。
