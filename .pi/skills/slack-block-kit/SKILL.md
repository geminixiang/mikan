---
name: slack-block-kit
description: Use when changing Slack Block Kit rendering, tools, or interactions.
license: MIT
---

# Slack Block Kit

## Relevant code

Start with `src/adapters/slack/tools/`, the Slack response lifecycle, and `src/test/slack-blockkit-tool.test.ts` as applicable. Use current implementation and Slack API contracts rather than treating historical workarounds as requirements.

## Integration concerns

- A successful Block Kit tool response must survive subsequent streaming updates and finalization. Mark it finalized only after the post succeeds; propagate API failures so the agent can correct the payload.
- Keep Slack-specific prompting and payload fields scoped to Slack. Preserve readable text fallbacks and human-readable interaction labels.
- Route actions according to the originating conversation/thread. A message timestamp alone does not establish a thread; synthetic action IDs should not masquerade as Slack message timestamps.
- Validate model-generated payloads at the tool boundary. Check supported blocks and element placement against current API/SDK definitions; do not turn a past `invalid_blocks` response into a permanent blanket restriction.
- Use native table blocks for tables rather than `section.fields`, which renders paired columns.
- Interactive controls can be clicked repeatedly. Authorization and lifecycle handling matter for actions with side effects.

## When rendering or interactions fail

Compare the outgoing payload, API result, and canonical message, then inspect later updates to the same message if blocks disappear. For missing actions, inspect delivered Socket Mode events before changing routing or scopes. Add only the instrumentation needed to distinguish the suspected causes; avoid logging secrets or unnecessary private content.

Canonical API data establishes what Slack stored, not how the client rendered it. Desktop verification requires explicit UI authorization; load `slack-desktop-cdp` only for that task. Choose regression tests for the behavior changed rather than running a fixed checklist.
