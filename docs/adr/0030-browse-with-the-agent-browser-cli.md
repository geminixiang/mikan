---
status: accepted
---

# Browse with the agent-browser CLI

mikan no longer offers a browser tool. The model browses with the sandbox's `agent-browser` CLI through `bash`, and the prompt points it at the CLI's version-matched skill (`agent-browser skills get core`). This removes `jev_browser`, its Jev goal loop, and the browser-control half of [ADR 0025](0025-office-desktop-shared-with-people.md); the office desktop itself stays.

## Context

[docs/research/browser-tool-vs-cli-2026-11.md](../research/browser-tool-vs-cli-2026-11.md) measured three arms on the same runtime and prompt: the tool without its goal loop, bash with the CLI, and bash with Playwright scripts.

- On a realistic intranet judged by server-side state, the tool succeeded in 27 of 42 runs, the CLI in 34, and Playwright scripts in 36. The tool also used the most tokens.
- With the CLI, the model reads the CLI's own skill first and follows it: compact `snapshot -i` and a session it names itself, the per-thread isolation the tool existed to provide.
- `agent-browser select` reports success on a custom `role=combobox` while changing nothing. Inside the tool's structured result the model trusted it; with the CLI the same model checked the page and clicked the option instead.
- Playwright scripts were cheapest but start a new browser each time, so a follow-up message signed in again, which a site with two-factor sign-in would not allow.
- In production the goal loop finished 27 of its 102 goals. Production predates the office desktop, so the hand-off and the desktop's browser control were never used.

## Decision

- Remove `jev_browser`: its goal loop, the form text written by a second model call, its per-runner browser session, its tab limit, and its hand-off to a person.
- The prompt names the `agent-browser` CLI, tells the model to start with its skill, and asks it to reuse one session per task and close it, because each session starts another Chrome and a few once exhausted a 1 GB sandbox.
- Remove browser control from the office desktop: the desktop page's take-control and hand-back buttons, `/desktop/control`, the viewer count that handed control back, and `mikan-desktop status` and `control`. The desktop still shows and operates the sandbox.

## Consequences

- A browser the model starts with the CLI is headless, so it does not appear on the office desktop. Showing it there, and handing a step such as signing in to a person, are left until someone needs them.
- Nothing in mikan limits how many browsers the model opens; the prompt asks it to reuse and close sessions, and the container's memory limit bounds the damage.
- Jev is no longer used by any tool except `jev`; Slack auto-reply and DM task intent still use it.
- A session that called `jev_browser` before the upgrade keeps that call in its history; a new call to the old name fails as an unknown tool.
