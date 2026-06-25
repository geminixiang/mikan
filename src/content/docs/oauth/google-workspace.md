---
title: Google Workspace CLI OAuth setup
description: Configure Google Workspace CLI OAuth so mikan can store and project Google Workspace credentials.
sidebar:
  order: 3
  label: Google Workspace CLI
---

> Note: mikan stores the Google authorized_user JSON in the vault and saves target path metadata. The `image` sandbox automatically projects this vault file into the container target path; existing `container` / `firecracker` runtimes still do not automatically project files.

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
export GOOGLE_WORKSPACE_CLI_CLIENT_ID="<client-id>"
export GOOGLE_WORKSPACE_CLI_CLIENT_SECRET="<client-secret>"
```

If `LINK_PORT` is not set, mikan listens on `8181` by default when `LINK_URL` exists.

Optional: override default scopes:

```bash
export GOOGLE_WORKSPACE_CLI_OAUTH_SCOPES="https://www.googleapis.com/auth/drive https://mail.google.com/ https://www.googleapis.com/auth/calendar"
```

## 3. Use `/login`

If you want later runtime executions to automatically project this credential file to `/root/.config/gws/credentials.json`, start mikan with the `image` sandbox:

```bash
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

In a DM with the bot, type:

```text
/login
```

Open the link returned by mikan and choose Google Workspace CLI OAuth.

After success, mikan stores the authorized user credential as a vault file, for example:

```json
{
  "client_id": "...",
  "client_secret": "...",
  "refresh_token": "...",
  "type": "authorized_user"
}
```

The default metadata target path is:

```text
/root/.config/gws/credentials.json
```

## Notes

- mikan uses a web OAuth callback, so the Google OAuth client must be `Web application`, not a desktop app.
- If Google does not return a `refresh_token`, revoke the existing consent and run `/login` again. mikan requests `access_type=offline` and `prompt=consent`, but Google may still omit the refresh token because of existing authorization.
- To make `gws.json` appear automatically at `/root/.config/gws/credentials.json`, use the `image` sandbox. `container` / `firecracker` currently only save file credential metadata and do not project it automatically.
