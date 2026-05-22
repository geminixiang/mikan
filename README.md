# mama (Multi-Agent Mischief Assistant)

[![npm version](https://img.shields.io/npm/v/@geminixiang/mama.svg)](https://www.npmjs.com/package/@geminixiang/mama)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A multi-platform AI assistant for Slack, Telegram, and Discord.

Forked from [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono)'s `mom` package (MIT, by Mario Zechner) at v0.57.1. This fork adds Telegram and Discord adapters and exists to ship internally while we prepare changes to upstream.

## Features

- **Multi-platform** — Slack, Telegram, Discord adapters
- **Concurrent conversations** — Slack threads, Discord replies/threads, and Telegram reply chains run as independent sessions
- **Sandbox execution** — host, shared container, per-user managed container, Firecracker (alpha), or Cloudflare bridge (experimental)
- **Credential vaults** — `/login` stores credentials under `--state-dir` and injects env into sandbox runs
- **Web session viewer** — read-only web view of the current session via `session` / `/session`
- **Persistent memory** — workspace-level and channel-level `MEMORY.md`
- **Skills** — drop CLI tools into `skills/`
- **Events** — schedule one-shot or recurring tasks via JSON files
- **Multi-provider** — any provider/model supported by `pi-ai`

## Platform Session Model

| Platform | `sessionKey` Rule                                                                 | Notes                                                                                |
| -------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Slack    | top-level / DM: `conversationId`; thread: `conversationId:threadTs`               | thread inherits parent context at fork time only; branch changes do not merge back   |
| Discord  | DM: `channelId`; shared top-level: `channelId:messageId`; reply/thread: rooted id | replies in shared channels continue the root message session; DM replies do not fork |
| Telegram | private: `chatId`; shared top-level: `chatId:messageId`; reply chain: root reply  | no native thread model; shared sessions are inferred from reply chains               |

## Requirements

- Node.js >= 20

## Installation

```bash
npm install -g @geminixiang/mama
```

Or from source:

```bash
npm install && npm run build
```

## Quick Start

All platforms share the same CLI:

```bash
mama [--state-dir=~/.mama] [--sandbox=<mode>] <working-directory>
```

Set the platform tokens you need (you can run multiple platforms at once):

```bash
export MAMA_SLACK_APP_TOKEN=xapp-...
export MAMA_SLACK_BOT_TOKEN=xoxb-...
export MAMA_TELEGRAM_BOT_TOKEN=123456:ABC-...
export MAMA_DISCORD_BOT_TOKEN=MTI...
```

### Slack

Create a Socket Mode app with the scopes and event subscriptions listed in [docs/slack-bot-minimal-guide.md](docs/slack-bot-minimal-guide.md). The bot responds when `@mentioned` in channels and to all DMs.

### Telegram

Create a bot via [@BotFather](https://t.me/BotFather) and copy the token. The bot responds to all private messages, and to `@mention` or reply chains in groups. Use `/login`, `/session`, `/new`, and `/stop` for controls.

### Discord

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications), enable **Message Content Intent**, and invite the bot with `Send Messages`, `Read Message History`, `Attach Files`. The bot responds to `@mentions` in servers and to all DMs.

## Sandbox Modes

| Mode                         | Description                                                            |
| ---------------------------- | ---------------------------------------------------------------------- |
| `host` (default)             | Run on host; no vault env injection                                    |
| `container:<name>`           | Run in an existing shared container; uses vault key `container-<name>` |
| `image:<image>`              | Auto-provision one Docker container per resolved vault/user            |
| `firecracker:<vm-id>:<path>` | Firecracker microVM (alpha; not recommended)                           |
| `cloudflare:<sandbox-id>`    | Cloudflare Worker bridge (experimental; no auto workspace sync)        |

Vault routing: `image`, `firecracker`, and `cloudflare` resolve a vault per platform userId. See [docs/sandbox.md](docs/sandbox.md) for the full matrix.

### Managed per-user containers (`image:*`)

```bash
docker pull ghcr.io/geminixiang/mama-sandbox:latest
mama --sandbox=image:ghcr.io/geminixiang/mama-sandbox:latest /path/to/workspace
```

Or build locally:

```bash
docker build -f docker/mama-sandbox.Dockerfile -t mama-sandbox:tools .
```

mama creates one container per vault, attaches each to its own bridge network, mounts the workspace at `/workspace`, injects vault env, mounts declared credential files, and stops idle containers.

### Firecracker / Cloudflare

See [docs/firecracker-setup.md](docs/firecracker-setup.md) and [examples/cloudflare-sandbox-bridge/README.md](examples/cloudflare-sandbox-bridge/README.md).

## `/login` and Web Session Viewer

```bash
export MAMA_LINK_URL="https://mama.example.com"   # public base URL
export MAMA_LINK_PORT=8181                         # optional, defaults to 8181
```

For local testing you can set just `MAMA_LINK_PORT`; mama will use `http://localhost:<port>`.

- `/login` / `/pi-login` (DM only) returns a 15-minute link to store API keys or run built-in OAuth flows ([GitHub](docs/oauth/github.md), [Google Workspace](docs/oauth/google-workspace.md), [Google Cloud SDK / gcloud](docs/oauth/google-cloud-sdk.md)).
- `session` / `/session` (DM only) returns a read-only link showing the current session timeline.
- `new` / `/new` (DM only) resets the current session and starts fresh.
- `model` / `/model` / `/pi-model provider/model[:thinking]` switches the LLM for the current conversation, e.g. `/pi-model anthropic/claude-sonnet-4-6:off`.
- `auto-reply` / `/pi-auto-reply on|off|status` controls group/channel auto-reply for the current conversation. Rules live in the conversation's `auto-reply` marker file.
- `stop` / `/stop` stops the current run. On Slack, use text commands so thread-local stop routing remains accurate.
- On Slack you can also register native commands like `/pi-login`, `/pi-session`, `/pi-model`, `/pi-auto-reply`, and `/pi-new`.

Credentials are stored under `<state-dir>/vaults` (default `~/.mama/vaults`). Vault env is only injected in `container`, `image`, `firecracker`, and `cloudflare` modes.

Shared login profiles live under `<state-dir>/vaults/shared/<name>`. `/pi-login copy <name>` merge-copies that shared profile into the current conversation vault: shared env keys overwrite matching conversation env keys, conversation-only env keys are kept, and files from the shared profile overwrite files at the same relative path. To seed every new managed sandbox vault from a shared profile, fill in `sandbox.defaultSharedVault` in `<state-dir>/settings.json` (onboard creates it as an empty string), for example `{ "sandbox": { "defaultSharedVault": "claw" } }`. Empty string disables the default. The default profile is copied only when the target vault does not exist yet.

## Configuration

mama reads global settings from `<state-dir>/settings.json` (default `~/.mama/settings.json`, override via `--state-dir` or `MAMA_STATE_DIR`). This file is required and is created explicitly with `mama --onboard`. Per-conversation settings live at `<workingDir>/<conversationId>/settings.json` and override global settings for that conversation.

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off"
  },
  "sentry": {
    "dsn": "https://examplePublicKey@o0.ingest.sentry.io/0"
  },
  "sandbox": {
    "cpus": "0.5",
    "memory": "512m",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    }
  }
}
```

| Field                  | Default             | Description                                           |
| ---------------------- | ------------------- | ----------------------------------------------------- |
| `llm.provider`         | `anthropic`         | AI provider                                           |
| `llm.model`            | `claude-sonnet-4-6` | Model name                                            |
| `llm.thinkingLevel`    | `off`               | `off` / `low` / `medium` / `high`                     |
| `sentry.dsn`           | unset               | Sentry DSN; sensitive prompt/tool content is redacted |
| `sandbox.cpus`         | unset               | CPU limit for managed containers                      |
| `sandbox.memory`       | unset               | Memory limit for managed containers                   |
| `sandbox.boost.cpus`   | unset               | Temporary CPU limit used by `/pi-sandbox boost`       |
| `sandbox.boost.memory` | unset               | Temporary memory limit used by `/pi-sandbox boost`    |

`/pi-sandbox` shows the current managed-container CPU/memory limits. `/pi-sandbox boost` temporarily applies `sandbox.boost` to the current conversation; the boost ends when that sandbox container is stopped.

Conversation-local settings written by `/pi-model` use the same shape and usually only include the override:

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off"
  }
}
```

mama writes logs to stdout/stderr. Use your process manager or host platform (for example PM2, systemd, Docker, or a cloud logging agent) to route logs to your preferred backend.

## Layout

```
<state-dir>/
├── settings.json
└── vaults/
    └── <vault-id>/
        ├── env
        └── ...                # credential files

<working-directory>/
├── MEMORY.md                  # global memory
├── SYSTEM.md                  # installed packages / env log
├── skills/                    # global skills
├── events/                    # scheduled events
└── <conversation-id>/
    ├── MEMORY.md
    ├── auto-reply[.disabled]    # optional channel auto-reply rules
    ├── log.jsonl
    ├── attachments/
    ├── scratch/
    ├── skills/
    └── sessions/
```

## Events

Drop JSON files into `<working-directory>/events/`:

```json
// Immediate
{"type": "immediate", "platform": "slack", "conversationId": "C0123456789", "conversationKind": "shared", "text": "Deploy finished"}

// One-shot
{"type": "one-shot", "platform": "telegram", "conversationId": "574247312", "conversationKind": "direct", "text": "Standup", "at": "2025-12-15T09:00:00+08:00"}

// Periodic (cron)
{"type": "periodic", "platform": "discord", "conversationId": "1498975469343739948", "conversationKind": "shared", "text": "Check inbox", "schedule": "0 9 * * 1-5", "timezone": "Asia/Taipei"}
```

## Skills

```
skills/my-tool/
├── SKILL.md      # name + description frontmatter, usage docs
└── run.sh
```

```yaml
---
name: my-tool
description: Does something useful
---

Usage: {baseDir}/run.sh <args>
```

## Slack: Download channel history

```bash
mama --download C0123456789
```

## Production deployment (PM2)

For long-running deployments, use [PM2](https://pm2.keymetrics.io/) as a process supervisor. It daemonizes mama, restarts on crash, and survives reboots.

```bash
# 1. Install mama and pm2
npm i -g @geminixiang/mama pm2

# 2. Start the sandbox container (long-lived; mama execs into it)
docker pull ghcr.io/geminixiang/mama-sandbox:latest

# 3. Grab the ecosystem file, edit args + env tokens, then start
curl -O https://raw.githubusercontent.com/geminixiang/mama/main/deploy/pm2/ecosystem.config.cjs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # run the printed command to enable boot autostart
```

Upgrade flow:

```bash
npm i -g @geminixiang/mama && pm2 reload mama
```

`pm2 reload` sends SIGTERM and waits up to `kill_timeout` (60s in the shipped config) before SIGKILL. mama's internal graceful shutdown drains in-flight LLM turns within that window, so reloads do not interrupt active conversations.

See [`deploy/pm2/ecosystem.config.cjs`](deploy/pm2/ecosystem.config.cjs) for all tunables.

## Development

```bash
npm run dev     # watch mode
npm test
npm run build
```

## License

MIT — see [LICENSE](LICENSE). Inherits from pi-mom.
