---
title: GitHub OAuth setup
description: Create a GitHub OAuth App so mikan /login can store and inject GitHub credentials.
sidebar:
  order: 1
  label: GitHub
---

## 1. Create a GitHub OAuth App

In GitHub, go to:

```text
Settings → Developer settings → OAuth Apps → New OAuth App
```

Fill in:

- Application name: for example `mikan`
- Homepage URL: your `LINK_URL`
- Authorization callback URL: `<LINK_URL>/oauth/callback`

Example:

```text
LINK_URL=https://mikan.example.com
Callback URL=https://mikan.example.com/oauth/callback
```

## 2. Set environment variables

```bash
export LINK_URL="https://mikan.example.com"
export GITHUB_OAUTH_CLIENT_ID="<client-id>"
export GITHUB_OAUTH_CLIENT_SECRET="<client-secret>"
```

If `LINK_PORT` is not set, mikan listens on `8181` by default when `LINK_URL` exists.

## 3. Start mikan

```bash
mikan --sandbox=container:mikan-tools /path/to/workspace
```

Or use a managed per-user container:

```bash
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

Or:

```bash
mikan --sandbox=firecracker:192.168.1.100:/path/to/workspace /path/to/workspace
```

## 4. Use `/login`

In a DM with the bot, type:

```text
/login
```

Open the link returned by mikan and choose GitHub OAuth.

After success, mikan writes the token into the corresponding vault's `env`, including:

```text
GITHUB_OAUTH_ACCESS_TOKEN
GH_TOKEN
```

In `container` / `image` / `firecracker` sandboxes, these env vars are injected into later tool runs.

## Scopes

Default GitHub OAuth scopes:

```text
repo read:user user:email read:org gist
```

Override them with an environment variable:

```bash
export GITHUB_OAUTH_SCOPES="repo read:user user:email read:org gist workflow"
```

Only add scopes you actually need. Higher-privilege scopes increase risk if credentials leak.
