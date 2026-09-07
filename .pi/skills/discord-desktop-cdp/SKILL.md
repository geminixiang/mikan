---
name: discord-desktop-cdp
description: Use when explicitly asked to operate or inspect the Discord desktop UI.
license: MIT
---

# Discord Desktop CDP

Use the REST API for message content, flags, and components; use the client for rendering and interactions.

Before opening a debug port, explain that local processes can access the logged-in session and obtain confirmation. Bind sends to the intended conversation with `CDP_EXPECT_CONVERSATION`. Restart Discord normally afterward to close the port, or tell the user it remains open.

For setup, driver commands, and client-specific troubleshooting, read [references/OPERATIONS.md](references/OPERATIONS.md). The driver is `cdp.mjs` in this skill directory; inspect its source only when needed.
