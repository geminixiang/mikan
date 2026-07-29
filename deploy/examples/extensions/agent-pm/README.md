# agent-pm — mikan extension example

A follow-up tracker implemented as a single TypeScript `index.ts` with zero
**runtime** dependencies. Storage uses the Node built-in `node:sqlite`; the
example requires the same Node.js `>=22.19.0` baseline as mikan.

It demonstrates the extension features needed by a realistic stateful tool:
custom tools, hooks, per-conversation data, schedules, proactive messages,
metadata, and bundled skills. It is not an exhaustive example of every hook or
`api.react`.

Types come from the mikan package (dev dependency) via
`import type { MikanExtensionApi } from "@geminixiang/mikan"` for completions;
loaded by jiti with no build step. Entrypoint is declared in `package.json`
under `mikan.extensions`.

## What it does

- **`followup` tool** (`registerTool`): the model can `add` / `list` / `done` /
  `cancel` / `note` / `remind` to manage this conversation's tracked items.
- **Per-turn injection** (`before_agent_start` hook): open items are appended to
  the system prompt so each turn starts aware of follow-ups and overdue work.
- **Daily overdue scan** (`api.schedules`): on activate, registers a cron
  schedule that becomes a mikan event file — every day at 09:00 an autonomous
  agent run fires even if no one messages, to chase overdue items.
- **Proactive messaging** (`api.notify`): the `remind` action posts the list
  to the channel without going through a normal agent reply.
- **Data directory** (`api.paths.dataDir`, default): SQLite under
  `<stateDir>/conversations/<officeKey>/extension-data/agent-pm/` — host-only,
  never in the sandbox. One db per conversation (free isolation) — the usual
  install for single-channel/DM follow-up tracking. For a cross-channel PM view (one
  table over all channels), use `api.paths.sharedDataDir` and partition by
  `conversation_id` yourself.
- **package.json**: `mikan.extensions` declares the entrypoint;
  name/version/description use standard npm fields (single metadata source).
- **skills/**: ships `follow-up-triage` SKILL.md, body inlined into the
  system prompt (sandbox cannot read host-only paths, so extension skills are
  always inline).

## Install

Use `mikan ext` (validates, installs to the correct path, prints slug and data
locations):

```sh
# install from GitHub (no local clone) — one conversation (common)
mikan ext install github:geminixiang/mikan#deploy/examples/extensions/agent-pm --conversation <id>

# or all conversations
mikan ext install github:geminixiang/mikan#deploy/examples/extensions/agent-pm --global

# or from a local path
mikan ext install ./agent-pm --global
```

After installation, send `/pi-new` in each affected conversation. Installation
copies the source into the host-only state directory, so editing the original
checkout does not update the installed copy. Re-run the same `mikan ext install`
command to replace code while preserving extension data, then send `/pi-new`.
No mikan process restart is required because each new harness instance loads
extensions through jiti without a module cache.

Use the same `--state-dir` as the running mikan instance when it is not the
default `~/.mikan`.

> To develop your own extension, install mikan for types with
> `npm install --save-dev --ignore-scripts @geminixiang/mikan`, import
> `MikanExtensionApi`, then implement `activate(api: MikanExtensionApi)`.
> `mikan ext dev ./my-extension` runs it in a stdin/stdout conversation on the
> same runtime, with no Slack workspace and no install step.

## Secrets (unused in this sample, but available)

If an extension needs third-party tokens (for example Linear or GitHub), an
administrator writes `KEY=value` lines to
`<stateDir>/vaults/extensions/agent-pm/env`. Extension code reads them through
`api.secrets.get("LINEAR_TOKEN")`; it cannot update them through this API.
Secrets are keyed by the installed slug (`agent-pm`), not the display name.

## Example flow

```
user: remember, vendor quote needs a reply by Friday
agent:  (followup add "reply to vendor quote" due=2026-07-10) noted, tracking it.

-- next day 09:00, nobody messages --

mikan:  (schedule fires autonomous run → followup list → finds overdue)
        ⚠️ "reply to vendor quote" is overdue (due 2026-07-10); please update status.
```

## Extension API coverage

| Need                            | Status                                    |
| ------------------------------- | ----------------------------------------- |
| Custom tool                     | ✅ `registerTool`                         |
| Per-turn context injection      | ✅ `before_agent_start`                   |
| Conversation scope              | ✅ `api.context.conversationId`           |
| Timed proactive reminder (idle) | ✅ `api.schedules` (cron / one-shot)      |
| Post to platform proactively    | ✅ `api.notify`                           |
| Private data directory          | ✅ `api.paths.dataDir`                    |
| Secrets                         | Available through `api.secrets`; not used |
| Identity / version              | ✅ `package.json` (name/version)          |
| Bundled skills                  | ✅ `skills/` (`SKILL.md`, auto-inlined)   |
| Reactions                       | Available through `api.react`; not used   |
| Other lifecycle/tool hooks      | Available; not demonstrated               |
