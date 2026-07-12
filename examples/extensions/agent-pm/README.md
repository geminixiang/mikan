# agent-pm — mikan extension example

A follow-up tracker: single-file TypeScript `index.ts` (~250 lines), zero
**runtime** dependencies (storage uses Node built-in `node:sqlite`), covering
the full extension v1 + v2 surface.

Types come from the mikan package (dev dependency) via
`import type { MikanExtensionApi } from "@geminixiang/mikan"` for completions;
loaded by jiti with no build step. Entrypoint is declared in `package.json`
under `mikan.extensions`.

## What it does

- **`followup` tool** (`registerTool`): the model can `add` / `list` / `done` /
  `cancel` / `note` / `remind` to manage this conversation's tracked items.
- **Per-turn injection** (`before_agent_start` hook): open items are appended to
  the system prompt so each turn starts aware of follow-ups and overdue work.
- **Daily overdue scan** (v2 `api.schedules`): on activate, registers a cron
  schedule that becomes a mikan event file — every day at 09:00 an autonomous
  agent run fires even if no one messages, to chase overdue items.
- **Proactive messaging** (v2 `api.notify`): the `remind` action posts the list
  to the channel without going through a normal agent reply.
- **Data directory** (v2 `api.paths.dataDir`, default): sqlite under
  `<stateDir>/conversations/<id>/extension-data/agent-pm/` — host-only, never
  in the sandbox. One db per conversation (free isolation) — the usual install
  for single-channel/DM follow-up tracking. For a cross-channel PM view (one
  table over all channels), use `api.paths.sharedDataDir` and partition by
  `conversation_id` yourself.
- **package.json** (v2): `mikan.extensions` declares the entrypoint;
  name/version/description use standard npm fields (single metadata source).
- **skills/** (v2): ships `follow-up-triage` SKILL.md, body inlined into the
  system prompt (sandbox cannot read host-only paths, so extension skills are
  always inline).

## Install

Use `mikan ext` (validates, installs to the correct path, prints slug and data
locations):

```sh
# install from GitHub (no local clone) — one conversation (common)
mikan ext install github:geminixiang/mikan#examples/extensions/agent-pm --conversation <id>

# or all conversations
mikan ext install github:geminixiang/mikan#examples/extensions/agent-pm --global

# or from a local path
mikan ext install ./agent-pm --global
```

After install, send `/pi-new` in that conversation. To update, **install again**
(replaces code, keeps data). After editing `index.ts`, the next harness
instance reloads (jiti does not cache); no process restart required.

> To develop your own extension: `npm i -D @geminixiang/mikan` for types,
> `import type { MikanExtensionApi } from "@geminixiang/mikan"`, then
> `activate(api: MikanExtensionApi)` for full completions.

## Secrets (unused in this sample, but available)

If an extension needs third-party tokens (e.g. Linear/GitHub), an admin writes
KEY=VALUE lines to `<stateDir>/vaults/extensions/agent-pm/env` and code reads
them with `api.secrets.get("LINEAR_TOKEN")` (read-only).

## Example flow

```
user: remember, vendor quote needs a reply by Friday
agent:  (followup add "reply to vendor quote" due=2026-07-10) noted, tracking it.

-- next day 09:00, nobody messages --

mikan:  (schedule fires autonomous run → followup list → finds overdue)
        ⚠️ "reply to vendor quote" is overdue (due 2026-07-10); please update status.
```

## Extension API coverage

| Need                            | Status                                     |
| ------------------------------- | ------------------------------------------ |
| Custom tool                     | ✅ `registerTool`                          |
| Per-turn context injection      | ✅ `before_agent_start`                    |
| Conversation scope              | ✅ `api.context.conversationId`            |
| Timed proactive reminder (idle) | ✅ v2 `api.schedules` (cron / one-shot)    |
| Post to platform proactively    | ✅ v2 `api.notify`                         |
| Private data directory          | ✅ v2 `api.paths.dataDir`                  |
| Secrets                         | ✅ v2 `api.secrets` (vault env, read-only) |
| Identity / version              | ✅ v2 `package.json` (name/version)        |
| Bundled skills                  | ✅ v2 `skills/` (SKILL.md, auto-inlined)   |
