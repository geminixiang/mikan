# Google Cloud SDK (gcloud) OAuth Setup

這份文件說明如何設定 mama `/login` / `/pi-login` 內建的 Google Cloud SDK OAuth，讓 sandbox 內的 `gcloud` 使用登入後的 user credential。

> 注意：mama 會把 Google `authorized_user` JSON 存進 vault，並保存 target path metadata。`image` sandbox 會把這類 vault file 自動投影到 container 內的 target path；現有 `container` / `firecracker` runtime 仍不會自動做 file projection。

## 1. 建立 Google OAuth Client

到 Google Cloud Console：

```text
APIs & Services → Credentials → Create Credentials → OAuth client ID
```

設定：

- Application type：`Web application`
- Authorized redirect URI：`<MAMA_LINK_URL>/oauth/callback`

範例：

```text
MAMA_LINK_URL=https://mama.example.com
Redirect URI=https://mama.example.com/oauth/callback
```

如果 OAuth app 還在 testing mode，請把使用者加入：

```text
OAuth consent screen → Test users
```

## 2. 設定環境變數

```bash
export MAMA_LINK_URL="https://mama.example.com"
export GOOGLE_CLOUD_SDK_CLIENT_ID="<client-id>"
export GOOGLE_CLOUD_SDK_CLIENT_SECRET="<client-secret>"
```

如果沒有設定 `MAMA_LINK_PORT`，mama 會在 `MAMA_LINK_URL` 存在時預設監聽 `8181`。

可選：覆蓋預設 scopes：

```bash
export MAMA_GOOGLE_CLOUD_SDK_OAUTH_SCOPES="openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform"
```

## 3. 使用 `/pi-login`

如果你希望後續 runtime 自動把 credential file 投影到 `/root/.config/gcloud/application_default_credentials.json`，建議用 `image` sandbox 啟動 mama：

```bash
mama --sandbox=image:mama-sandbox:tools /path/to/workspace
```

在與 bot 的私訊中輸入：

```text
/pi-login
```

打開 mama 回傳的 link，選擇 **Google Cloud SDK (gcloud)**。

成功後，mama 會：

- 存入 vault file：`gcloud-adc.json`
- 在 sandbox 投影到：`/root/.config/gcloud/application_default_credentials.json`
- 設定 env：
  - `GOOGLE_APPLICATION_CREDENTIALS=/root/.config/gcloud/application_default_credentials.json`
  - `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=/root/.config/gcloud/application_default_credentials.json`

`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` 會讓 `gcloud` 優先使用這份 credential file。

## Notes

- mama 使用 web OAuth callback，因此 Google OAuth client 必須是 `Web application`，不是 desktop app。
- 如果 Google 沒有回傳 `refresh_token`，請撤銷既有 consent 後重新 `/pi-login`。mama 會要求 `access_type=offline` 與 `prompt=consent`，但 Google 仍可能因既有授權而省略 refresh token。
- 若要讓 credential file 自動出現在 `/root/.config/gcloud/application_default_credentials.json`，請使用 `image` sandbox。`container` / `firecracker` 目前仍只會保存 file credential metadata，不會自動投影。
