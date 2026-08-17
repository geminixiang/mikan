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
├── conversations/
│   └── <office-key>/
│       └── settings.json
└── vaults/
    ├── <office-key>/          # one conversation's credentials
    ├── shared/<name>/         # shared login profiles
    └── extensions/<slug>/     # extension secrets (host-side only)
```

You can also specify it with `--state-dir`:

```bash
mikan --state-dir=/secure/mikan-state --sandbox=container:mikan-tools /path/to/workspace
```

Credentials are then stored in:

```text
/secure/mikan-state/vaults/
```

The global settings file is at `<state-dir>/settings.json`. Conversation overrides are host-only at `<state-dir>/conversations/<office-key>/settings.json`. A legacy `<working-directory>/<conversationId>/settings.json` is migrated once, then ignored — conversation directories are mounted read-write into the sandbox, so settings deliberately live outside them.

At startup, mikan refuses a `--state-dir` that is world-writable or not owned by the current user. Newly created state/vault directories and credential files use private modes, but an existing group/world-readable state directory is not automatically tightened; use `chmod 0700 <state-dir>`.

## Vault contents

Each vault is a directory under `vaults/` and may contain:

- `env` file: environment variables in `KEY=value` form
- file credentials: for example `gws.json`, `.ssh/config`

mikan infers mount targets from file names/paths — `gws.json` → `/root/.config/gws/credentials.json`, `gcloud-adc.json` → `/root/.config/gcloud/application_default_credentials.json`, `.ssh/` → `/root/.ssh`, `.kube/` → `/root/.kube`, `.config/gh/` → `/root/.config/gh` — and anything else defaults to `/root/<relative-path>`. The target is derived from the file name every time the vault is resolved; it is not stored as metadata, so renaming a credential file changes where it lands. The built-in OAuth flows pick names that already infer to the right place and set the matching env var (for example `GOOGLE_APPLICATION_CREDENTIALS`) to it.

In image mode these are bind mounts and are writable from inside the sandbox, so tools may update them — keep backups for credentials whose mutation would matter. In `gondolin:default` the files are copied into the guest with owner-only permissions and are not written back, so a guest-side edit is discarded when the runtime is recreated.

Example:

```text
~/.mikan/vaults/
└── v1-slack-c0123456789-1a2b3c4d5e6f7a8b/
    ├── env
    └── gws.json
```

`env` example:

```env
GH_TOKEN=ghp_xxx
GITHUB_OAUTH_ACCESS_TOKEN=gho_xxx
```

## What reaches the sandbox

Vault material is not one undifferentiated class of secret:

- **A conversation's own vault is meant to reach the guest.** Its `env` entries become environment variables for tool commands, and its credential files are projected to their target paths (by default under `/root`). That is the whole point: the agent runs `gh`, `gcloud`, or `ssh` as the person who logged in.
- **The vault directory itself is never bulk-mounted.** Only the individual credential files that a resolved vault declares are projected, one mount per file, and only for the conversation whose key resolved.
- **Daemon tokens never reach the guest.** Platform bot tokens (`SLACK_BOT_TOKEN`, the GitHub App private key, and friends) are read by the mikan host process and are not part of any vault injection.
- **Extension secrets never reach the guest.** `vaults/extensions/<slug>/env` is read host-side through the extension API; it is not a user vault and is not mounted or injected.

This is a data boundary, not an execution boundary. Anything the conversation's own credentials can do, its agent can do — scope the credentials you store accordingly.

## Sandbox behavior

| Sandbox mode       | Vault env injection | File credentials        | Vault key                       |
| ------------------ | ------------------- | ----------------------- | ------------------------------- |
| `host`             | not injected        | refused                 | derived from the platform user  |
| `container:<name>` | injected            | refused                 | derived from the container name |
| `image:<image>`    | injected            | projected (bind mounts) | the office key                  |
| `gondolin:default` | injected            | projected (copied in)   | the office key                  |
| `firecracker:*`    | injected            | refused                 | the office key                  |
| `cloudflare:*`     | injected            | refused                 | the office key                  |

**Refused means the run fails, not that the file is quietly ignored.** A vault whose directory holds
any file other than `env` resolves to a file mount, and a mode that cannot mount files raises
`Sandbox type "<type>" does not support vault file mounts` instead of running with an incomplete
credential set. So on those modes, keep credentials in `env` only — a stray `gws.json` left in the
vault from an earlier `image` deployment will stop the conversation from running.

The office key is derived by hashing the platform name together with the platform's raw conversation id, so two platforms that share a raw id cannot resolve each other's credentials. Conversation vault directories created under the older raw-id scheme are renamed to office keys by the boot-time migration; a conflict (both directories present) stops boot for manual merge instead of picking one.

## Shared vaults

`sandbox.defaultSharedVault` names a profile under `vaults/shared/` that is copied into a new conversation's vault on first use. That ambient copy only happens for membership-gated platforms (Slack, Discord, Telegram) on the isolated `image` and `cloudflare` topologies. Open-trigger surfaces such as GitHub never inherit it — an admin can still provision a vault for a specific GitHub conversation explicitly.

## `/pi-login`

In a DM / private message, run:

```text
/pi-login
```

`/login` is accepted as the same command; Slack registers the `/pi-` spelling.

mikan creates a 15-minute onboarding link. In the web page, users can store:

- arbitrary API keys / env vars
- GitHub OAuth credentials
- Google Cloud SDK OAuth credentials
- Google Workspace CLI OAuth credentials

The command only works in DMs / private messages so other people in shared channels cannot obtain a credential onboarding link. The link is a bearer capability and is consumed once a credential write or OAuth callback completes — see [Portal auth and capability model](/portal-auth-model/).

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
