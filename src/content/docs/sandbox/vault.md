---
title: Vault
description: How mikan stores credentials in the state directory and injects env or file mounts by sandbox mode.
---

## State directory and vault location

The default state directory is:

```text
~/.mikan/
```

Important contents include:

```text
~/.mikan/
├── settings.json
└── vaults/
    └── <vault-id>/
```

You can also specify it with `--state-dir`:

```bash
mikan --state-dir=/secure/mikan-state --sandbox=container:mikan-tools /path/to/workspace
```

Credentials are then stored in:

```text
/secure/mikan-state/vaults/
```

The global settings file is at `<state-dir>/settings.json`. Conversation overrides are host-only at `<state-dir>/conversations/<conversationId>/settings.json`. A legacy `<working-directory>/<conversationId>/settings.json` is migrated once, then ignored.

At startup, mikan refuses a `--state-dir` that is world-writable or not owned by the current user. Newly created state/vault directories and credential files use private modes, but an existing group/world-readable state directory is not automatically tightened; use `chmod 0700 <state-dir>`.

## Vault contents

Each vault is a directory under `vaults/` and may contain:

- `env` file: environment variables in `KEY=value` form
- file credentials: for example `gws.json`, `.ssh/config`

mikan infers mount targets from file names/paths, such as `gws.json` → `/root/.config/gws/credentials.json`, `gws-client.json` → `/root/.config/gws/client_secret.json` (the OAuth client config `gws` needs to refresh or re-issue tokens inside the sandbox), and `.ssh/` → `/root/.ssh`. In image mode these credential mounts are writable from inside the sandbox, so tools may update them; keep backups for credentials whose mutation would matter.

Example:

```text
~/.mikan/vaults/
└── container-mikan-tools/
    ├── env
    └── gws.json
```

`env` example:

```env
GH_TOKEN=ghp_xxx
GITHUB_OAUTH_ACCESS_TOKEN=gho_xxx
```

## Sandbox behavior

| Sandbox mode       | Vault env injection | File credential projection | Vault key                                                      |
| ------------------ | ------------------- | -------------------------- | -------------------------------------------------------------- |
| `host`             | not injected        | not projected              | credentials can be stored, but not injected into host commands |
| `container:<name>` | injected            | not projected              | `container-<name>`                                             |
| `image:<image>`    | injected            | automatically projected    | generated conversation vault, usually the conversation ID      |
| `firecracker:*`    | injected            | not projected              | generated conversation vault                                   |
| `cloudflare:*`     | injected            | not projected              | generated platform-scoped conversation vault                   |

## `/login`

In a DM / private message, run:

```text
/login
```

mikan creates a 15-minute onboarding link. In the web page, users can store:

- arbitrary API keys / env vars
- GitHub OAuth credentials
- Google Workspace CLI OAuth credentials

`/login` only works in DMs / private messages so other people in shared channels cannot obtain a credential onboarding link.

## Enable the link server

For production deployments, set the public URL:

```bash
export LINK_URL="https://mikan.example.com"
```

If `LINK_PORT` is not set, mikan defaults to port `8181` when `LINK_URL` exists.

You can also set it explicitly:

```bash
export LINK_PORT=8181
```

For local testing, you can set only:

```bash
export LINK_PORT=8181
```

The `/login` link will then use:

```text
http://localhost:8181
```

OAuth callback URL is:

```text
<LINK_URL>/oauth/callback
```
