---
name: slack-desktop-cdp
description: Use when explicitly asked to operate or inspect the Slack desktop UI.
license: MIT
---

# Slack Desktop CDP

Use API/log evidence for message content; use the client for rendering and interactions.

Before opening a debug port, explain that local processes can access the logged-in session and obtain confirmation. Bind sends to the intended conversation with `CDP_EXPECT_CONVERSATION`; do not retain unrelated private content. Restart Slack normally afterward to close the port, or tell the user it remains open.

For setup, driver commands, and client-specific troubleshooting, read [references/OPERATIONS.md](references/OPERATIONS.md). The driver is `cdp.mjs` in this skill directory; inspect its source only when needed.
