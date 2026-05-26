# Configuration

mikan reads global settings from `<state-dir>/settings.json` (default `~/.mikan/settings.json`, override with `--state-dir` or `STATE_DIR`). This file is created explicitly with `mikan --onboard`.

Per-conversation settings live at `<working-directory>/<conversationId>/settings.json` and override global settings for that conversation.

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
    }
  }
}
```

## Fields

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

Every environment variable also supports a `MIKAN_` prefix for deployment-specific namespacing. For example, `MIKAN_SLACK_APP_TOKEN` and `MIKAN_LINK_URL` are accepted fallbacks. Unprefixed variables take precedence.

mikan writes logs to stdout/stderr. Use your process manager or host platform (for example PM2, systemd, Docker, or a cloud logging agent) to route logs to your preferred backend.
