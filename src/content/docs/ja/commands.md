---
title: Chat commands
---

# Chat commands

mikan supports text commands across platforms. Slash-command aliases are available where the platform supports them.

| Command                                                    | Purpose                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/login` / `/pi-login`                                     | Open a 15-minute link to store API keys or run built-in OAuth flows. DM only.                    |
| `session` / `/session`                                     | Open a web view of the current session. DM only.                                                 |
| `new` / `/new`                                             | Reset the current session and start fresh. DM only.                                              |
| `model` / `/model` / `/pi-model provider/model[:thinking]` | Switch the LLM for the current conversation, e.g. `/pi-model anthropic/claude-sonnet-4-6:off`.   |
| `auto-reply` / `/pi-auto-reply on\|off\|status`            | Control group/channel auto-reply for the current conversation.                                   |
| `stop` / `/stop`                                           | Stop the current run. On Slack, use text commands so thread-local stop routing remains accurate. |
| `/pi-sandbox`                                              | Show or temporarily boost managed-container CPU/memory limits.                                   |

On Slack you can register native commands like `/pi-login`, `/pi-session`, `/pi-model`, `/pi-auto-reply`, and `/pi-new`.

## Web session viewer

The session viewer uses the same link server as login/vault and admin. The current session view can display the timeline and, when interactive portal wiring is enabled, send messages back into that session.

```bash
export LINK_URL="https://mikan.example.com"   # public base URL
export LINK_PORT=8181                         # optional, defaults to 8181
```

For local testing you can set just `LINK_PORT`; mikan will use `http://localhost:<port>`.

See [Portal auth and capability model](portal-auth-model.md) for how admin, login/vault, and session-view links differ.

## OAuth flows

Built-in OAuth docs:

- [GitHub](oauth/github.md)
- [Google Workspace](oauth/google-workspace.md)
- [Google Cloud SDK / gcloud](oauth/google-cloud-sdk.md)
