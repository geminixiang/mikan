---
title: Google Cloud SDK OAuth setup
description: Configure Google Cloud SDK OAuth so gcloud inside the sandbox can use the logged-in user credential.
sidebar:
  order: 2
  label: Google Cloud SDK
---

> Note: mikan stores the Google `authorized_user` JSON in the vault as `gcloud-adc.json`, and the runtime target is inferred from that file name. The `image` sandbox automatically projects the file to that target inside the runtime. `container` and `cloudflare` cannot mount files at all and fail the run rather than proceed without the credential, so do not use this flow on those modes.

## 1. Create a Google OAuth Client

In Google Cloud Console, go to:

```text
APIs & Services → Credentials → Create Credentials → OAuth client ID
```

Configure:

- Application type: `Web application`
- Authorized redirect URI: `<LINK_URL>/oauth/callback`

Example:

```text
LINK_URL=https://mikan.example.com
Redirect URI=https://mikan.example.com/oauth/callback
```

If the OAuth app is still in testing mode, add users at:

```text
OAuth consent screen → Test users
```

## 2. Set environment variables

```bash
export LINK_URL="https://mikan.example.com"
export GOOGLE_CLOUD_SDK_CLIENT_ID="<client-id>"
export GOOGLE_CLOUD_SDK_CLIENT_SECRET="<client-secret>"
```

If `LINK_PORT` is not set, mikan listens on `8181` by default when `LINK_URL` exists.

Optional: override default scopes:

```bash
export GOOGLE_CLOUD_SDK_OAUTH_SCOPES="openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform"
```

## 3. Use `/pi-login`

If you want later runtime executions to automatically project the credential file to `/root/.config/gcloud/application_default_credentials.json`, start mikan with the `image` sandbox:

```bash
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

In a DM with the bot, type:

```text
/pi-login
```

Open the link returned by mikan and choose **Google Cloud SDK (gcloud)**.

After success, mikan:

- stores vault file: `gcloud-adc.json`
- projects it in the sandbox to: `/root/.config/gcloud/application_default_credentials.json`
- sets env:
  - `GOOGLE_APPLICATION_CREDENTIALS=/root/.config/gcloud/application_default_credentials.json`
  - `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=/root/.config/gcloud/application_default_credentials.json`

`CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE` makes `gcloud` prefer this credential file.

## Notes

- mikan uses a web OAuth callback, so the Google OAuth client must be `Web application`, not a desktop app.
- If Google does not return a `refresh_token`, revoke the existing consent and run `/pi-login` again. mikan requests `access_type=offline` and `prompt=consent`, but Google may still omit the refresh token because of existing authorization.
- To make the credential file appear automatically at `/root/.config/gcloud/application_default_credentials.json`, use the `image` sandbox. On `container` and `cloudflare` a file credential in the vault makes the run fail with `does not support vault file mounts` — remove it and use `env`-only credentials there.
