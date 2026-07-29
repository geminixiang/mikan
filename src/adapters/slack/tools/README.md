# src/adapters/slack/tools

This directory contains agent tools related to the Slack adapter.

## Files

- `attach.ts`: Defines the `attach` tool, allowing the agent to upload runtime files back to the chat platform. It lives here for historical reasons but is platform-neutral: `src/tools/index.ts` registers it in the core tool set for every platform and binds it to the active responder's upload path (adapters that cannot attach files, like GitHub, fall back to a pointer note).
- `blockkit.ts`: Defines the `slack_blockkit` tool, allowing the agent to post and update interactive Block Kit messages (buttons, select menus). Bound per-conversation via `../tool-pack.ts`; interactions come back through the `block_actions` handler as `[Slack action]` conversation events.
