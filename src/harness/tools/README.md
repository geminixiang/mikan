# src/harness/tools

This directory contains the platform-neutral tools mikan exposes to the agent.
Platform-specific tools live with their adapter (`adapters/slack/tools/`,
`adapters/github/tools/`) and reach the agent as a `PlatformToolPack`.

**Every tool schema needs a required `label` parameter.** The system prompt
tells the model every tool takes one, and `harness/presenter.ts` renders it
as the run's current progress-line step; a missing one silently falls back
to the bare tool name (or doubles it, for a tool whose name is also
prefixed onto its progress line). Use `defineHostFnTool` (below), which
injects it automatically, or add it to the schema by hand as `jev.ts` and
`attach.ts` do. `src/test/tool-label-contract.test.ts` enforces this across
every assembled tool, with a small, documented exemption list — extend that
list with a reason rather than silently joining the unenforced set.

## What enters the session

A tool call's name and arguments (including `label`) are part of the assistant
message; its final `toolResult` is a separate session message. A short result
therefore does **not** mean the call's input was omitted. The result's `content`
(text or image) and, when present, `details` can be persisted. After a run,
`src/sessions/session-store.ts` rebuilds model context from message entries;
compaction can replace older entries with a summary and retained tail. A
`tool_update`/`onUpdate` is forwarded as a live progress event, not an
independent persisted message. If progress data is also returned in the final
result, that copy does enter the session.

In the table, ✓ means the data enters a session when that call succeeds; ◇
means it depends on the operation, input, or returned data; — means the tool
does not return that category. The **arguments** column includes potentially
large input even when the result is brief. The **progress** column identifies
live updates, **not** another session entry. Tool errors may also leave an
error result in the session. Platform tools are present only when their pack is
configured, `generate_image` only when image generation is configured, and MCP
tools depend on the connected server's `listTools()` response.

| Tool                    | Arguments | Final text/data | Image in result | `details` in session |                        Live progress                        | Data carried by the call/result                                                                           |
| ----------------------- | :-------: | :-------------: | :-------------: | :------------------: | :---------------------------------------------------------: | --------------------------------------------------------------------------------------------------------- |
| `read`                  |     ✓     |        ◇        |        ◇        |          ◇           |                              —                              | Path/range; file text or supported image content.                                                         |
| `write`                 |     ✓     |        ✓        |        —        |          —           |                              —                              | Full text to write in arguments; write confirmation.                                                      |
| `edit`                  |     ✓     |        ✓        |        —        |          ✓           |                              —                              | Original/replacement text in arguments; diff/patch in result.                                             |
| `bash`                  |     ✓     |        ✓        |        —        |          ◇           |                              ✓                              | Command in arguments; stdout/stderr and exit information.                                                 |
| `codemode`              |     ✓     |        ◇        |        ◇        |          —           |                              ✓                              | Script in arguments; only emitted output and return value enter model history, not nested tool results.   |
| `tool_search`           |     ✓     |        ✓        |        —        |          ✓           |                              —                              | Query/namespace/limit; loaded names in the result and branch discovery state.                             |
| `event`                 |     ✓     |        ✓        |        —        |          —           |                              —                              | Event payload in arguments; list/read data or write/delete confirmation.                                  |
| `sandbox`               |     ✓     |        ✓        |        —        |          —           |                              —                              | CPU/memory limits and status (supported on managed image sandboxes).                                      |
| `attach`                |     ✓     |        ✓        |        —        |          —           |                              —                              | Path/title and attached filename; not the file bytes as a result.                                         |
| `generate_image`        |     ✓     |        ✓        |        —        |          —           |                              —                              | Generation request and attached filename; image stored/uploaded elsewhere.                                |
| `react`                 |     ✓     |        ✓        |        —        |          ◇           |                              —                              | Emoji and reaction confirmation.                                                                          |
| `jev`                   |     ✓     |        ✓        |        —        |          —           |                              —                              | State/questions in arguments; answers, model and usage in result.                                         |
| `jev_browser`           |     ✓     |        ✓        |        —        |          —           |                              —                              | URL/commands in arguments; status, history, snapshot and raw command results.                             |
| `history`               |     ✓     |        ✓        |        —        |          —           |                              —                              | Action/query/session/paging; bounded entries from this office's sessions (incl. tool output) or chat log. |
| `start_task`            |     ✓     |        ✓        |        —        |          —           |                              —                              | Task target and admission confirmation.                                                                   |
| `task_status`           |     ✓     |        ✓        |        —        |          —           |              Session key and task status JSON.              |
| `slack_blockkit`        |     ✓     |        ✓        |        —        |          —           | Blocks/text in arguments; posted/updated message timestamp. |
| `github_pr`             |     ✓     |        ✓        |        —        |          —           |     PR request in arguments; operation status and URL.      |
| `github_checks`         |     ✓     |        ✓        |        —        |          —           |          Branch/job ID; check summary or job log.           |
| `github_review_reply`   |     ✓     |        ✓        |        —        |          —           |          Reply body in arguments; thread and URL.           |
| `github_read`           |     ✓     |        ✓        |        —        |          —           |          Query and formatted PR/issue/review data.          |
| `github_issue`          |     ✓     |        ✓        |        —        |          —           |             Issue request and operation report.             |
| `subagent`              |     ✓     |        ✓        |        —        |          ✓           |                              ✓                              | Task/tool grants; final outcomes in text **and** `details`.                                               |
| `mcp__<server>__<tool>` |     ✓     |        ✓        |        ◇        |          —           |                              —                              | Dynamic tool arguments; bounded compact server text (full result spilled), images.                        |

This is a **data-flow inventory**, not a guarantee that every result is small
or safe. `jev_browser` bounds the goal-loop snapshot but does not impose one
aggregate limit on raw command results; native file/command output, subagent
outcomes and GitHub check logs can also be large; MCP text is bounded like `bash`. Image bytes
and external artifacts (written files, uploads, Slack messages) should not be
confused with the short confirmation returned by some tools. `withSecretRedaction`
only scrubs final text `content` for tools assembled by `createMikanTools` and
for MCP tools; it does not scrub arguments, `details`, images or progress, and
the runner adds `subagent` separately. Do not treat this as a universal secret
filter.

## Codemode

`codemode.ts` uses the official `pi-codemode` QuickJS/WASM worker, not host
`eval` or a second executor. `MikanAgentSession` adds it after resolving each
run's grants, including subagent grants; a tool-less session remains tool-less.
Scripts cannot call `codemode` or `start_task`. Existing direct tools remain
available. `ALL_TOOLS` lists only granted tools, `searchTools(query, options)`
searches that same authorized catalog, and `describeTool(name)` supplies full
declarations. Discovery helpers are asynchronous globals, not methods on
`tools`. Their definitions supply both the sandbox and Pi's public
`renderDeclarations({ globals })`, so the model-facing API cannot drift from
the injected functions. Discovery returns Pi-generated `renderToolSample()`
text, including argument and result declarations. Declared output schemas are
preserved; tools without one use Pi's text-result default rather than `unknown`.
Models inspect unknown declarations in one script before writing a later call
script, instead of guessing arguments or treating JSON text as an object. The guide follows Pi's global-helper and nested-tool
layout without importing private CLI modules or advertising unsupported APIs.
MCP schemas are omitted from the inline description altogether; other tool
declarations share its 12,000-character limit, separate from the complete global
helper declarations. Script discovery does not activate schemas in the model's
direct tool set.

pi-durable has no nested-tool dispatch API. The small local exception is
`session.ts`'s `executeNestedTool`: it uses the same loop guard, cancellation,
progress translation and tool-call accounting as direct calls, while
`codemode.ts` uses Pi's public argument validator. Each nested call gets the
codemode call's tool API with its own call ID and captured output. Replace this
bridge when Pi exposes nested dispatch; it does not run other extensions'
`beforeTool`/`afterTool` hooks or make nested calls independent durable tasks.

Nested calls/results are not appended to the model transcript; only script
output is. Tool-only text becomes a string, structured results retain their
shape, and image results return `{ content }` so scripts can forward blocks
with `image(result.content[0])`. Calls still appear in live progress and run
counts. A script failure does not roll back completed tool side effects.
Cancellation closes the worker and waits for nested tools to settle, so tools
must cooperate with their signal. Defaults are a 60-second script deadline,
a 64-MiB VM heap, and up to 40,000 text characters of emitted output; the
options header can request another deadline or a smaller output budget.

Durable `store`/`load` and classifier helpers are not implemented. Store values
last only for one script. MCP tools retain their existing bounded result
behavior; codemode does not reconnect clients or expand grants.

## Deferred MCP discovery

MCP tools carry `exposure: "deferred"` and their server's `namespace` from
`mcp.ts`; ordinary platform and execution tools remain direct. Connections and
`listTools()` still happen during runner construction. Only schema declaration
is deferred, not network connection or authorization.

`tool-search.ts` owns keyword ranking and `tool_search`, which loads matches
through pi-durable's `control.addTools` result for the next model call; Pi
stores the offered names in the conversation's `pi.agent` document. The
shared search considers names, descriptions and argument schemas, prioritizes
exact names, and supports a namespace filter and a 1–20 match limit (default 5).
It is a small local weighted-keyword ranker, not Pi CLI's private BM25
implementation; the CLI extension cannot be imported into the native harness
through a public ranker API. No private Pi imports or additional dependency are
used. Search result summaries are bounded to 300 characters per tool.

`tool_search` exists only when the current grants include deferred tools. It
searches only not-yet-loaded tools; codemode's `searchTools()` searches all of
its granted callable tools without loading anything. Neither can discover
another office's tools or escape a subagent's profile grants. `tool_search` is
model-only and not callable from codemode.

Every search in one tool batch adds its matches, so the batch loads their
union. The loaded names live in Pi's `pi.agent` document, out of the model's
text, and survive compaction and close/reopen. Each run offers only the stored
names that current grants still include, so an earlier discovery cannot
restore revoked access. A known MCP tool can still be called from codemode without loading its
schema. Direct calls must wait until a later model request after discovery;
loading is not a second permission grant.

## Browser reliability

`jev_browser` carries a short, tool-specific native CLI guide instead of adding
browser rules to every agent's system prompt. It can read plain-text native
`--help` / `skills` output so advice matches the installed CLI. An obvious
`press @ref Enter` mistake is rejected before side effects; this is not a
second CLI parser. A raw batch stops at its first reported failure and skips
the goal loop. Separate essential capture exports if later commands must run
even when an earlier export fails. Reuse a known named session when continuity
is useful: with the current native CLI, every additional session owns another
agent-browser daemon and Chromium process tree inside the same conversation
sandbox. Create one only for real isolation or parallel work, and close it when
done. After this tool explicitly closes a session, a later no-URL reuse in the
same runner is rejected instead of letting the CLI silently create about:blank;
providing a URL explicitly starts it again. Calls from one runner are serialized,
so a model response containing several one-off calls cannot create a burst of
parallel Chromium trees. Different conversation threads have different runners
and may still work in parallel when their separate sessions are intentional.

Goal decisions receive bounded full-page text and local snapshot context for
same-label targets. History records commands, not verified effects: current
state wins. Three unchanged observations after actions, or a third visit to a
state in a short alternating cycle, hand control back rather than keep clicking.
These guards are conservative stop conditions, not proof that a goal is
impossible; slow pages may need an explicit native wait. They do not turn a
model's DONE into independent verification. The caller should verify the
intended visible state, consult help before unfamiliar syntax, and allow at
most one evidence-based correction rather than retrying an unchanged goal.

## Contracts

- `generate_image` writes host-side into the office directory, the only host location the guest can also reach, and uploads from that host path, because the file may not be mounted in the sandbox the way `attach` assumes.
- `withSecretRedaction` scrubs every configured secret env value from each assembled tool's text output; in host sandbox mode it is the only defense against a command or file read returning a secret. It mutates `execute` in place so the `isHarnessTool` marker and a platform pack's `bindRun` binding survive wrapping.
- `jev` reports a missing `OPENROUTER_API_KEY` as a tool error, never a silent fallback.
- Each runner's `jev_browser` owns one browser, named by the tool rather than the model, that stays open until `close: true`; a later `url` opens a new tab, and opening past three tabs first closes the oldest inactive ones. Model-named sessions each started another Chrome, and a few of them exhausted a 1 GB sandbox until every page load timed out. Every command, including cleanup, runs through the actor-resolved sandbox `Executor`, and a missing `agent-browser` is a provisioning error, never an automatic install or a host fallback.
- `subagent.ts` owns the progress protocol that the presenter renders: snapshot bounds, parsing, merging, settling, and the Markdown dashboard.
