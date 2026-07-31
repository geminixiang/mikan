---
title: Slack Bot minimal setup guide
description: Minimal Slack app permissions, events, and manifest settings required to run mikan through Socket Mode.
---

You can also create the app from an example manifest. There are two, because
Slack offers two surfaces and mikan serves both:

| Manifest                                    | Surface        | Use when                                                                                                                          |
| ------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `deploy/examples/slack-app-manifest.json`   | Classic app    | People talk to mikan by @mentioning it in channels and by DM.                                                                     |
| `deploy/examples/slack-agent-manifest.json` | Agent (AI app) | You also want mikan in the **Agents & AI apps** sidebar, with its own pane, greeting, suggested prompts, and a conversation list. |

The agent manifest is the classic one plus three things: the `agent_view`
feature, the `assistant:write` scope, and the `assistant_thread_started` /
`assistant_thread_context_changed` events. Everything else — slash commands,
Socket Mode, message events — is identical, and the same mikan process serves
either. Start from the classic one if you are not sure; adding the agent
surface later is an edit to the same app.

> `agent_view` and `assistant_view` are two surfaces, not two spellings of
> one. The events and the `assistant.threads.*` methods kept their names, but
> **which events mean "someone opened a conversation" changed**: `agent_view`
> uses `app_home_opened` (with `tab: "messages"`) and `app_context_changed`,
> while `assistant_view` uses `assistant_thread_started` and
> `assistant_thread_context_changed`. mikan handles both, so either manifest
> works. New apps can only choose `agent_view`; `assistant_view` still works
> but Slack has said it will eventually be deprecated.

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
- `assistant:write` (agent surface only — the `assistant.threads.*` methods
  that set the pane's status, suggested prompts, and conversation title)
- `channels:history`
- `channels:read`
- `chat:write`
- `commands` (required only when using the optional slash commands below)
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

This is what puts mikan in the **Agents & AI apps** sidebar with its own pane.
Skip it for a classic app.

In the pane, mikan greets the person when they open a conversation, offers
suggested prompts shaped by the channel they are viewing, shows a working
status while it thinks, and names each conversation from its first message so
the sidebar list is navigable. Each conversation there is a thread, and mikan
gives every thread its own session — the sidebar is a list of separate
conversations, not one transcript, and continuity across them comes from
memory rather than from a shared session.

## 5. Subscribe to bot events

Go to **Features → Event Subscriptions** and enable events.

Subscribe to these bot events:

- `app_home_opened`
- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`

Plus, for the agent surface, the events that say someone opened the pane and
where they are looking. Subscribe the pair that matches your manifest key —
subscribing all four is harmless and covers either:

- `agent_view`: `app_context_changed` (and `app_home_opened`, already above)
- `assistant_view`: `assistant_thread_started`, `assistant_thread_context_changed`

Without them the pane has no suggested prompts and its conversations stay
untitled in the sidebar.

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

mikan needs its global settings file and an LLM provider key once — `mikan --onboard` and `export ANTHROPIC_API_KEY=...`; see [Quickstart](/quickstart/) — then:

```bash
export SLACK_APP_TOKEN=xapp-...
export SLACK_BOT_TOKEN=xoxb-...

mikan
```

The state directory defaults to `~/.mikan` and the working directory to `<state-dir>/workspace`; pass `--state-dir=<dir>` or a path argument to change them. `mikan --help` lists all flags, and `mikan env` shows which variables are currently set.

The bot responds in DMs and when mentioned in channels. Triggered Slack thread work uses an isolated session whose key includes the thread timestamp. An ordinary unmentioned reply in a shared-channel thread is logged but does not start a run.

## 9. Choose a sandbox

Without `--sandbox`, mikan runs tools directly on the host, and the default `isolated` door policy
refuses that combination by design — the first message reports that `host` cannot provide an isolated
conversation office. Pick one before your first real conversation:

- **Recommended.** Use the managed sandbox, which gives each conversation its own container and
  satisfies the isolated policy with no settings change:

  ```bash
  mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:latest
  ```

- **Host mode**, only on a machine you already trust with the whole workspace: add a trusted door
  policy to `~/.mikan/settings.json`.

  ```json
  {
    "sandbox": {
      "workspace": { "doorPolicy": "trusted", "layout": "shared-support" }
    }
  }
  ```

See [Sandbox](/sandbox/) for the full comparison.
