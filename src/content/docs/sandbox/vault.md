---
title: Vault
---

# Vault

mikan stores credentials outside the workspace in the state directory, then injects them into sandbox executions according to the active sandbox mode.

## State directory and vault path

The default state directory is:

```text
~/.mikan/
```

Important files:

```text
~/.mikan/
├── settings.json
└── vaults/
    └── <vault-id>/
```

You can override it with `--state-dir`:

```bash
mikan --state-dir=/secure/mikan-state --sandbox=container:mikan-tools /path/to/workspace
```

Credentials are then stored under:

```text
/secure/mikan-state/vaults/
```

Global settings live at `<state-dir>/settings.json`. Conversation-local settings live at `<working-directory>/<conversationId>/settings.json` and override global defaults for that conversation.

At startup, mikan rejects a `--state-dir` that is world-writable or not owned by the current user, so other local users cannot tamper with settings or vault contents.

## Vault contents

Each vault is a directory under `vaults/`. It can contain:

- `env` file: environment variables in `KEY=value` format
- file credentials: for example `gws.json` or `.ssh/config`

mikan infers mount targets from names/paths, for example `gws.json` → `/root/.config/gws/credentials.json` and `.ssh/` → `/root/.ssh`.

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

| Sandbox mode       | Vault env injection | File credential projection | Vault key                                                         |
| ------------------ | ------------------- | -------------------------- | ----------------------------------------------------------------- |
| `host`             | No                  | No                         | Credentials can be stored but are not injected into host commands |
| `container:<name>` | Yes                 | No                         | `container-<name>`                                                |
| `image:<image>`    | Yes                 | Yes                        | generated conversation vault, usually the conversation ID         |
| `firecracker:*`    | Yes                 | No                         | generated conversation vault                                      |
| `cloudflare:*`     | Yes                 | No                         | generated platform-scoped conversation vault                      |

## `/login`

Users run this in a DM/private chat:

```text
/login
```

mikan returns a 15-minute onboarding link. The web page can store:

- arbitrary API keys / env vars
- GitHub OAuth credentials
- Google Workspace CLI OAuth credentials

`/login` only works in DM/private chat, so other people in a shared channel cannot grab the credential onboarding link.

## Enable the link server

For production, set the public URL:

```bash
export LINK_URL="https://mikan.example.com"
```

If `LINK_PORT` is not set, mikan defaults to port `8181` when `LINK_URL` exists.

You can also set the port explicitly:

```bash
export LINK_PORT=8181
```

For local testing, setting only `LINK_PORT` is enough:

```bash
export LINK_PORT=8181
```

The `/login` link will use:

```text
http://localhost:8181
```

OAuth callback URL:

```text
<LINK_URL>/oauth/callback
```
