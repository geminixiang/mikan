# src/adapters/slack/tools

This directory contains agent tools related to the Slack adapter.

## Files

- `attach.ts`: Defines the `attach` tool, allowing the agent to upload runtime files back to the chat platform.
- `blockkit.ts`: Defines the `slack_blockkit` tool, allowing the agent to post and update interactive Block Kit messages (buttons, select menus). Bound per-conversation via `../tool-pack.ts`; interactions come back through the `block_actions` handler as `[Slack action]` conversation events.
