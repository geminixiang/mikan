---
title: Configuration
description: Configure global and per-conversation model, sandbox, Slack reply mode, auto-reply, and vault defaults.
---

Global settings live in `<state-dir>/settings.json`; the default state directory is `~/.mikan`.

Each conversation has settings at `<working-directory>/<conversationId>/settings.json`, which override the global settings for that conversation.

## Example

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
    },
    "image": {
      "workspaceMount": "private"
    },
    "defaultSharedVault": ""
  },
  "slack": {
    "replyMode": "top-level"
  }
}
```

## Fields

| Field                          | Default             | Description                                                                   |
| ------------------------------ | ------------------- | ----------------------------------------------------------------------------- |
| `llm.provider`                 | `anthropic`         | AI provider                                                                   |
| `llm.model`                    | `claude-sonnet-4-6` | Model name                                                                    |
| `llm.thinkingLevel`            | `off`               | `off` / `low` / `medium` / `high`                                             |
| `sentry.dsn`                   | unset               | Sentry DSN; sensitive prompt / tool content is redacted                       |
| `sandbox.cpus`                 | unset               | CPU limit for managed containers                                              |
| `sandbox.memory`               | unset               | Memory limit for managed containers                                           |
| `sandbox.boost.cpus`           | unset               | Temporary CPU limit used by `/pi-sandbox boost`                               |
| `sandbox.boost.memory`         | unset               | Temporary memory limit used by `/pi-sandbox boost`                            |
| `sandbox.image.workspaceMount` | `private`           | `private` mounts only the conversation workspace; `full` mounts all workspace |
| `sandbox.defaultSharedVault`   | unset               | Default shared vault key for conversations without their own vault            |
| `slack.replyMode`              | `top-level`         | Slack response mode: `top-level` or `thread`                                  |

`/pi-sandbox` shows the current managed container CPU / memory limits. `/pi-sandbox boost` temporarily applies `sandbox.boost` to the current conversation; the boost ends when that sandbox container stops.

Conversation-local settings use the same shape and override global settings for that conversation. Settings written by `/pi-model` usually contain only model overrides:

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off"
  }
}
```

Every environment variable also supports a `MIKAN_` prefix for deployment-specific namespacing. For example, `MIKAN_SLACK_APP_TOKEN` and `MIKAN_LINK_URL` are accepted fallbacks. Unprefixed variables take precedence.

mikan writes logs to stdout/stderr. Use your process manager or host platform, such as PM2, systemd, Docker, or a cloud log agent, to route logs to your preferred backend.
