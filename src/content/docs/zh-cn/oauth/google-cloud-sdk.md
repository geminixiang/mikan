---
title: Google Cloud SDK OAuth 设定
description: 设定 Google Cloud SDK OAuth，让 sandbox 内的 gcloud 使用登入后的 user credential。
sidebar:
  order: 2
  label: Google Cloud SDK
---

> 注意：mikan 会把 Google `authorized_user` JSON 存进 vault，并保存 target path metadata。`image` sandbox 会把这类 vault file 自动投影到 container 内的 target path；现有 `container` / `firecracker` runtime 仍不会自动做 file projection。

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
export GOOGLE_CLOUD_SDK_CLIENT_ID="<client-id>"
export GOOGLE_CLOUD_SDK_CLIENT_SECRET="<client-secret>"
```

如果没有设定 `LINK_PORT`，mikan 会在 `LINK_URL` 存在时预设监听 `8181`。

可选：覆盖预设 scopes：

```bash
export GOOGLE_CLOUD_SDK_OAUTH_SCOPES="openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform"
```

## 3. 使用 `/pi-login`

如果你希望后续 runtime 自动把 credential file 投影到 `/root/.config/gcloud/application_default_credentials.json`，建议用 `image` sandbox 启动 mikan：

```bash
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

在与 bot 的私讯中输入：

```text
/pi-login
```

打开 mikan 回传的 link，选择 **Google Cloud SDK (gcloud)**。

成功后，mikan 会：

- 存入 vault file：`gcloud-adc.json`
- 在 sandbox 投影到：`/root/.config/gcloud/application_default_credentials.json`
- 设定 env：
  - `GOOGLE_APPLICATION_CREDENTIALS=/root/.config/gcloud/application_default_credentials.json`
  - `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=/root/.config/gcloud/application_default_credentials.json`

`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` 会让 `gcloud` 优先使用这份 credential file。

## 注意事项

- mikan 使用 web OAuth callback，因此 Google OAuth client 必须是 `Web application`，不是 desktop app。
- 如果 Google 没有回传 `refresh_token`，请撤销既有 consent 后重新 `/pi-login`。mikan 会要求 `access_type=offline` 与 `prompt=consent`，但 Google 仍可能因既有授权而省略 refresh token。
- 若要让 credential file 自动出现在 `/root/.config/gcloud/application_default_credentials.json`，请使用 `image` sandbox。`container` / `firecracker` 目前仍只会保存 file credential metadata，不会自动投影。
