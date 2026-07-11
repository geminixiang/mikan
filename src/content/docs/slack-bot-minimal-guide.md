---
title: Slack Bot minimal setup guide
description: Minimal Slack app permissions, events, and manifest settings required to run mikan through Socket Mode.
---

You can also create the app with the example manifest in `examples/slack-app-manifest.json`.

## 1. Create a Slack app

1. Open <https://api.slack.com/apps>.
2. Click **Create New App**.
3. Choose **From scratch**.
4. Pick an app name, for example `mikan`, and select your workspace.

## 2. Enable Socket Mode

1. Go to **Settings → Socket Mode**.
2. Turn on **Enable Socket Mode**.
3. Create an app-level token with the `connections:write` scope.
4. Store the token as `SLACK_APP_TOKEN`.

The token starts with `xapp-`.

## 3. Configure bot token scopes

Go to **OAuth & Permissions → Scopes → Bot Token Scopes** and add:

- `app_mentions:read`
- `assistant:write`
- `channels:history`
- `channels:read`
- `chat:write`
- `files:read`
- `files:write`
- `groups:history`
- `groups:read`
- `im:history`
- `im:read`
- `im:write`
- `reactions:write`
- `users:read`

Then install or reinstall the app to your workspace and store the bot token as `SLACK_BOT_TOKEN`.

The token starts with `xoxb-`.

## 4. Enable App Home and Agent mode

1. Go to **Features → App Home**.
2. Enable **Home Tab**.
3. Enable **Agent or Assistant** under **Agents & AI Apps**.

This sends Slack native assistant thread events and working indicators to the bot.

## 5. Subscribe to bot events

Go to **Features → Event Subscriptions** and enable events.

Subscribe to these bot events:

- `app_home_opened`
- `app_mention`
- `assistant_thread_context_changed`
- `assistant_thread_started`
- `message.channels`
- `message.groups`
- `message.im`

## 6. Enable interactivity

Go to **Features → Interactivity & Shortcuts** and enable interactivity.

If you only use Socket Mode for local development, you do not need a public request URL, though Slack may still require one in some app settings.

## 7. Optional slash commands

The example manifest includes common control slash commands:

- `/pi-login` → login portal
- `/pi-new` → start a new DM session
- `/pi-session` → session viewer
- `/pi-model` → switch this conversation's LLM (`provider/model[:thinking]`, for example `anthropic/claude-sonnet-4-6:off`)
- `/pi-auto-reply` → manage group/channel auto-reply rules
- `/pi-sandbox` → inspect or tune this conversation's sandbox
- `/pi-extensions` → list installed extensions
- `/pi-admin` → open the admin portal

Slash commands are optional because text commands also work in supported contexts. Keep `stop` as a text command (`stop` or `/stop`) so thread-local stop routing can point at the correct session.

## 8. Run mikan

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...

mikan --state-dir ~/.mikan /path/to/workspace
```

The bot responds in DMs and when mentioned in channels. Slack thread replies use isolated thread sessions and include the thread timestamp as part of the session key.
