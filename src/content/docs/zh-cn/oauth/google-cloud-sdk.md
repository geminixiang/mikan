---
title: Google Cloud SDK OAuth 设定
description: 设定 Google Cloud SDK OAuth，让 sandbox 内的 gcloud 使用登入后的 user credential。
sidebar:
  order: 2
  label: Google Cloud SDK
---

> 注意：mikan 会把 Google `authorized_user` JSON 以 `gcloud-adc.json` 的名称存进 vault，runtime 内的 target 由该文件名推断而来。`image` 和 `gondolin` sandbox 会自动把该文件投影到 runtime 内的该 target。`container`、`firecracker` 和 `cloudflare` 完全无法 mount 文件，遇到这种情况会让该次运行失败，而不是在缺少 credential 的情况下继续，因此请不要在这些模式上使用此流程。

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

如果你希望后续 runtime 自动把 credential file 投影到 `/root/.config/gcloud/application_default_credentials.json`，建议用 `image` sandbox（或 `gondolin:default`）启动 mikan：

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
- 若要让 credential file 自动出现在 `/root/.config/gcloud/application_default_credentials.json`，请使用 `image` 或 `gondolin` sandbox。在 `container`、`firecracker` 和 `cloudflare` 上，vault 中存在 file credential 会让该次运行以 `does not support vault file mounts` 失败——请删除它，并在这些模式上改用仅 `env` 的 credentials。
- 在 `gondolin:default` 中，该文件是以仅所有者可读的权限复制进 guest，而不是 bind-mount；在主机上轮换它会在该对话的下一条命令时重建 runtime，因此 guest 绝不会保留过期副本。
