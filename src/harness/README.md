# mikan agent harness

mikan's own agent harness layer. mikan previously depended on
`@earendil-works/pi-coding-agent` (`AgentSession`, `SessionManager`,
`ModelRegistry`, `AuthStorage`), but that package is a full single-user TUI
product. mikan only needed a fraction of it, and multi-session, headless,
multi-platform chat diverged from TUI assumptions. This module keeps the core
ideas from pi-coding-agent (append-only session tree, compaction, skills,
extension hooks) while sitting directly on
`@earendil-works/pi-agent-core` (agent loop, compaction algorithm, context
build) and `@earendil-works/pi-ai` (providers, models, auth resolution,
streaming).

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ mikan adapters / runtime / commands / web                  │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│ src/harness  (this module)                                 │
│                                                            │
│  MikanAgentSession (runner.ts)                             │
│    · prompt / subscribe / abort / reloadFromSession        │
│    · message persistence on message_end                    │
│    · auto-compaction (threshold + overflow recovery)       │
│    · auto-retry with exponential backoff                   │
│    · budget circuit breakers (token/cost/time/call caps)   │
│    · extension hook dispatch                               │
│                                                            │
│  SessionStore (session-store.ts)   MikanModels (models.ts) │
│    · v3 JSONL, append-only tree      · pi-ai Models set    │
│    · buildSessionContext             · models.json customs │
│                                      · auth.json creds     │
│  Skills (skills.ts)                FileCredentialStore     │
│  Extensions (extensions/)          Settings (settings.ts)  │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│ pi-agent-core: Agent loop, compaction, buildSessionContext │
│ pi-ai: providers, Models, auth resolution, streaming       │
└────────────────────────────────────────────────────────────┘
```

### Module responsibilities

| Module                            | Role                                                                                | Replaces (pi-coding-agent)                     |
| --------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| `runner.ts` `MikanAgentSession`   | Turn loop: persistence, auto-compaction, auto-retry, budget breakers, events, hooks | `AgentSession`                                 |
| `session-store.ts` `SessionStore` | Sync read/write of v3 JSONL session trees                                           | `SessionManager`                               |
| `models.ts` `MikanModels`         | Model catalog + auth resolution (including models.json custom providers)            | `ModelRegistry`                                |
| `auth.ts` `FileCredentialStore`   | `~/.mikan/auth.json` credential store (pi-ai `CredentialStore` implementation)      | `AuthStorage`                                  |
| `skills.ts`                       | SKILL.md discovery and system-prompt formatting                                     | `loadSkillsFromDir` / `formatSkillsForPrompt`  |
| `http.ts`                         | Global fetch: proxy support (`HTTP_PROXY`, etc.) + idle timeout                     | `http-dispatcher`                              |
| `settings.ts`                     | Compaction / retry defaults                                                         | `SettingsManager`                              |
| `extensions/`                     | mikan's extension system                                                            | extension loading from `DefaultResourceLoader` |

### Compatibility

- **Session file format is unchanged.** `SessionStore` reads and writes the
  existing v3 JSONL (`session` header line + entries with `id`/`parentId`).
  Entry shape matches pi-agent-core `SessionTreeEntry`, so
  `buildSessionContext` and the compaction pipeline run on these entries
  directly. Sessions written by older mikan builds reopen cleanly.
- **auth.json format is unchanged; path is `~/.mikan/auth.json`.** pi-ai
  `Credential` is the current auth.json shape; file contents can be reused, but
  paths under `~/.pi` are no longer read.
- **models.json subset.** `MikanModels` reads `~/.mikan/models.json`: providers
  with a `models` array become custom providers (`api` supports
  anthropic-messages / openai-completions / openai-responses /
  azure-openai-responses / google-generative-ai / mistral-conversations);
  entries with only `baseUrl`/`compat` override built-in provider models.
- **Event surface is unchanged.** `MikanAgentSession` events = pi-agent-core
  `AgentEvent` passthrough + `compaction_start/_end` + `auto_retry_start/_end` +
  `budget_exceeded`. Adapter renderers need no change (`budget_exceeded` is
  additive; old handlers ignore it).

## Budget circuit breakers

LLMs cannot reliably decide when to stop (halting problem), so runaway runs
must be stopped externally. `BudgetSettings` in `settings.ts` caps a single
`prompt()` (tokens, cost USD, wall time, LLM call count); any breach aborts the
run and emits `budget_exceeded`.

- **Interactive turns** are human-gated; defaults have no caps
  (`DEFAULT_BUDGET_SETTINGS = {}`).
- **Autonomous runs (event / trigger)** have no human watching;
  `agent.ts` / runner wiring passes `DEFAULT_EVENT_BUDGET` (10 minutes, 50 LLM
  calls, $2) as a stop-loss.

Caps are checked on each assistant `message_end` (mid-turn abort is possible)
and `handlePostRun` blocks retry/compaction from continuing after a budget trip.

## Prompt-cache friendly design

For Anthropic, pi-ai places a single cache breakpoint at the end of the system
prompt — any byte change to the system prompt cache-misses the whole request
(including expensive history). So `buildSystemPrompt` only includes content
**stable within a conversation**; turn-varying content (event-trigger mode,
attribution — which changes per speaker in multi-user channels) is delivered
via `buildTurnInstructions()` on the user message so the system prompt stays
byte-stable and cache-warm.

### Behavioral differences from pi-coding-agent

- Settings and credentials live under `~/.mikan/` (`auth.json`, `models.json`);
  nothing is read from `~/.pi/`.
- pi extensions (`.pi/extensions`) are not loaded; mikan's extension system
  replaces them (below).
- Prompt templates / `/skill:` expansion are outside the harness (mikan
  commands live in `src/commands/`).
- OAuth login is not wired here (OAuth tokens already in the credential file are
  still resolved and refreshed by pi-ai).

## Extension system

An extension is a module (`.mjs` / `.js` / **`.ts`**) under the **state dir**
(`extensions/` is host-only and never mounted into the sandbox):

```
~/.mikan/global/extensions/audit.mjs            # all conversations (single file)
~/.mikan/global/extensions/agent-pm/            # all conversations (directory)
  index.mjs | index.ts                          #   entrypoint
  package.json                                  #   optional: mikan.extensions + deps + metadata
  skills/<name>/SKILL.md                        #   optional: bundled skills (inlined)
~/.mikan/conversations/<id>/extensions/         # one conversation
```

**Loading uses jiti**, so extensions can be TypeScript and may `npm i`
third-party packages (with `node_modules`). `package.json` is the metadata
source — entrypoints are declared in `mikan.extensions` (array of relative
paths); name/version/description use standard npm fields; optional
`mikan.displayName` overrides display name (npm names are lowercase/scoped;
display names may be free-form). Example:

```json
{
  "name": "agent-pm",
  "version": "0.2.0",
  "description": "Follow-up tracker",
  "type": "module",
  "mikan": { "extensions": ["./index.ts"], "displayName": "Agent PM" },
  "dependencies": { "ms": "2.1.3" }
}
```

Entrypoint resolution order: `mikan.extensions` → `index.{mjs,js,ts,mts}`.
Simple extensions without `package.json` may use `manifest.json`
(`{name,version,description}`) as a metadata fallback.

`global/` and `conversations/<id>/` are parallel scopes, each with
`extensions/` (code) and `extension-data/` (data). Full layout and migration:
`src/harness/extensions/LAYOUT.md`.

### Install with CLI

`mikan ext` subcommands (validate, correct paths, print slug/data locations):

```sh
mikan ext validate <path>                                   # check a valid extension
mikan ext install <source> --global                         # all conversations
mikan ext install <source> --conversation <id>              # one conversation
mikan ext list [--conversation <id>]                        # list installed
mikan ext remove <slug> (--global | --conversation <id>)    # remove code (keep data)
```

`<source>` may be a **local path** or **git URL** (`https://…`, `git@…`, or
`github:owner/repo`), optionally with `#subpath` into a monorepo:

```sh
# install from GitHub (use # for a monorepo subdirectory)
mikan ext install github:geminixiang/mikan#examples/extensions/agent-pm --global
```

Git sources are shallow-cloned to a temp dir; if `dependencies` exist,
`npm install --omit=dev` runs, then validate + copy. `install` runs
`validate` first (import but **does not** activate — no side effects) and
rejects failures; installs into a named subdirectory to keep slugs stable.
**Reinstalling the same slug updates** (replace code, keep data). All commands
accept `--state-dir` (default `~/.mikan`). After install/remove, send
`/pi-new` in the conversation to activate.

**Security model:** extension code runs inside the mikan process with the same
privileges as mikan (platform tokens, vault, host filesystem). Installing
extensions is an admin action. Therefore extension directories must never live
under the workspace — image mode bind-mounts workspace/conversation dirs into
the sandbox, and sandbox-written code loaded on the host would be an escape.
`global` and `conversations` are reserved top-level scopes; platform
conversation ids never take those names.

**Identity (slug):** determined by install path (directory or file name), not
by manifest — secrets, schedules, and `sharedDataDir` ownership key on slug.
Per-conversation data (`dataDir`) lives under the conversation dir, named by
slug, and is torn down with the conversation.

Export `activate` (default or named):

```js
// extensions/audit.mjs
export default function activate(api) {
  api.on("tool_call", ({ toolName, args }) => {
    if (toolName === "bash" && String(args.command).includes("curl")) {
      return { block: true, reason: "network access is audited" };
    }
  });
  api.registerTool(myCustomTool);
  api.log("audit extension ready");
}
```

### Hooks (v1)

| Hook                 | When                           | Return value                               |
| -------------------- | ------------------------------ | ------------------------------------------ |
| `before_agent_start` | Before user prompt is sent     | `{ systemPrompt? }` override for this turn |
| `tool_call`          | Before tool execution          | `{ block?, reason? }` to block a tool      |
| `tool_result`        | After tool execution (observe) | —                                          |
| `message_end`        | After each message completes   | —                                          |
| `turn_end`           | After the turn ends            | —                                          |
| `session_compact`    | After compaction is written    | —                                          |

Semantics: handlers run in registration order; the first non-`undefined` return
wins for valued hooks; handler errors are logged only and do not abort the turn.

### Host-backed API: subagents, schedules, notify, paths, secrets, manifest, skills

The harness defines service interfaces (`ExtensionHostServices`) implemented by
the embedder (mikan wires them in the agent runner). Missing services throw
descriptive errors. That keeps the harness embeddable — other hosts can supply
messaging / scheduling.

| api                                | Purpose                                                                    | mikan backend                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `api.subagent.run`                 | Fresh isolated subagent run; optional tools, budget, and structured output | in-process `MikanAgentSession` with `SessionStore.inMemory()`                                   |
| `api.schedules.upsert/delete/list` | Named schedules (cron `periodic` / `one-shot`) for autonomous runs         | event files (`<workingDir>/events/ext.<slug>.<conv>.<name>.json`), live via EventsWatcher       |
| `api.notify(text)`                 | Post to this conversation without an agent run                             | `main.ts` `PlatformNotifier` → bot `postMessage`                                                |
| `api.react(messageTs, emoji)`      | React to a message (ts from events the extension observed)                 | `main.ts` `PlatformReactor` → bot `addReaction`                                                 |
| `api.paths.dataDir`                | **This conversation's** data dir (default; isolation free; mkdir-on-use)   | `conversations/<id>/extension-data/<slug>/`                                                     |
| `api.paths.sharedDataDir`          | Cross-conversation data (**explicit** multi-tenant apps; self-partition)   | `global/extension-data/<slug>/`                                                                 |
| `api.secrets.get/list`             | Read-only secrets                                                          | vault: `<stateDir>/vaults/extensions/<slug>/env`                                                |
| `manifest.json`                    | name / version / description (display only; slug unaffected)               | loader reads it                                                                                 |
| `skills/<name>/SKILL.md`           | Bundled skills                                                             | discovered and **inlined** into system prompt (sandbox cannot read host-only paths); local wins |

The same core subagent runner backs both extension `api.subagent.run` and the normal agent's built-in `subagent` tool. Both use a fresh in-memory session, explicit tool grants, bounded execution, and the same non-recursion guard. The runner never rejects — request validation failures resolve to `failed` results, so a bad request in a batch cannot orphan in-flight siblings. The normal tool folds each subagent's tokens and cost into the parent run's tally (`recordExternalUsage`), keeping delegated spend visible to the parent budget; extension-initiated runs report usage in their result, and the calling extension is accountable for it. The normal tool supports one `task`, up to eight independent parallel `tasks[]`, or a bounded in-memory `dag` (8 nodes, 16 edges, depth 4); at most 4 subagents run concurrently in either mode. DAG dependency outputs become structured input for downstream nodes; a failed dependency skips its descendants while independent branches continue.

The normal tool emits node-level state through `AgentTool.onUpdate`. The parent runner debounces `tool_execution_update` events for 500ms and sends a compact status label through `ConversationResponder.replaceResponse`, so Slack, Discord, and Telegram share the same progress path without exposing subagent reasoning.

Schedule `text` is a self-contained autonomous task (no conversation history).
With multiple platforms, `notify` / schedules need an explicit `platform`; a
single platform is inferred. Schedule files live under the events dir (sandbox
mounted, agent-writable) — slug prefixes are a **cooperative** convention, not a
security boundary. Do not put secrets in schedule text. Host/sandbox path map:
`src/sandbox/README.md`.

### Extension development mindset

> **Each instance gets its own room; shared living room only if you say so.**

`activate(api)` is called per conversation — one instance (avatar) per
conversation, with its own hooks, tools, and `context.conversationId`. On the
whole API surface, only **where to store data** needs an explicit choice;
everything else (hooks, tools, schedules, notify, secrets) is already scoped:

- **Single-conversation tools** (default): write to `api.paths.dataDir` — one
  room per conversation; naive code gets isolation for free.
- **Cross-conversation apps** (e.g. agent-pm): write to
  `api.paths.sharedDataDir` — that line declares multi-tenancy; partition by
  conversation id yourself and handle concurrency (sqlite/append; avoid
  full-file read-modify-write).

Failure modes are asymmetric on purpose: forgetting to share under isolation =
feature does not work (loud, safe); forgetting to filter under shared default =
cross-conversation leaks (quiet, harmful).

Lifecycle discipline:

1. **`activate` must be idempotent** — `/new` re-activates the same conversation
   (`schedules.upsert` is upsert for this reason).
2. **No `setInterval` / long-lived resources** — there is no deactivate; use
   `api.schedules` for timers.
3. **Code and data stay separate** — `extensions/` is the loader scan surface
   (any `.js` placed there is loaded as an extension) and upgrades replace the
   whole directory; state always goes to the data dir.

Full example: `examples/extensions/agent-pm/` (~200-line follow-up tracker with
sqlite, daily overdue scan schedule, proactive notify, bundled skill) — the
target shape for extensions: reuse mikan's harness instead of building a second
agent stack.

v3 candidates: `tool_result` patch, custom slash-command contribution points,
provider registration, install/uninstall lifecycle hooks.

## Tests

- `test/harness-session-store.test.ts` — v3 format, tree/branch, compaction expand
- `test/harness-runner.test.ts` — faux provider e2e: persistence, tools, hook block, auth precheck
- `test/harness-extensions.test.ts` — loader and hook registry
- `test/harness-skills.test.ts` — SKILL.md discovery and prompt formatting
- `test/harness-auth.test.ts` — auth.json read/write
