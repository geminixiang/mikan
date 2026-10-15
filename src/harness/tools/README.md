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
| `tool_search`           |     ✓     |        ✓        |        —        |          ✓           |                              —                              | Query/limit; loaded names in the result and branch discovery state.                                       |
| `event`                 |     ✓     |        ✓        |        —        |          —           |                              —                              | Event payload in arguments; list/read data or write/delete confirmation.                                  |
| `sandbox`               |     ✓     |        ✓        |        —        |          —           |                              —                              | CPU/memory limits and status (supported on managed image sandboxes).                                      |
| `attach`                |     ✓     |        ✓        |        —        |          —           |                              —                              | Path/title and attached filename; not the file bytes as a result.                                         |
| `generate_image`        |     ✓     |        ✓        |        —        |          —           |                              —                              | Generation request and attached filename; image stored/uploaded elsewhere.                                |
| `react`                 |     ✓     |        ✓        |        —        |          ◇           |                              —                              | Emoji and reaction confirmation.                                                                          |
| `jev`                   |     ✓     |        ✓        |        —        |          —           |                              —                              | State/questions in arguments; answers, model and usage in result.                                         |
| `jev_browser`           |     ✓     |        ✓        |        —        |          —           |                              —                              | URL/commands in arguments; status, history, snapshot and raw command results.                             |
| `web_fetch`             |     ✓     |        ✓        |        —        |          —           |                              —                              | URL in arguments; page Markdown or API text, bounded like MCP text (full result spilled).                 |
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
only scrubs final text `content` and the `structuredOutput` scripts read for tools
assembled by `createMikanTools` and for MCP tools; it does not scrub arguments,
`details`, images or progress, and
the runner adds `subagent` separately. Do not treat this as a universal secret
filter.

## Codemode

`codemode` and `tool_search` are pi-durable's own
(`@earendil-works/pi-durable/codemode` and `/tool-search`). `installRunTools`
selects them next to the session's extension: `codemode` whenever the run has
tools, `tool_search` only when a granted tool is `deferred`. A subagent child
copies its owner's extensions without these two, so it gets neither the tool
nor the `codemode` prompt section. One `CodemodeSandbox` (64-MiB heap) serves
every script in the process; Pi gives scripts no deadline unless they set
`timeout_ms`. `models.*` globals are off (`models: false`); images come from
`generate_image`.

Pi owns the script contract: the tool description, the `codemode` section
listing callable tools as declarations, `searchTools()` / `describeTool()` /
`describeNamespace()`, result layout and truncation (spilled through the
run's `ExecutionEnv`), `store()` / `load()` (Pi's `pi.codemode.store`
document, which `/new` clears), and replay after a restart. Each nested call
is its own `pi.tool` task, so mikan's `ToolTask` hooks (loop guard, notices,
subagent budgets) and its tool events apply to it as to a model call. A
schema-less tool resolves to its text, images left out; a tool with
`structuredOutputSchema` resolves to its `structuredOutput`, also on an error
result, so `tools.bash` gives `{ output, exitCode, ... }`.

mikan supplies only the tool fields Pi reads: `start_task` has
`callers: ["model"]`, so scripts cannot start tasks; Pi's `codemode` and
`tool_search` take no `label`, so the session's extension wraps them with a
required one (`withRequiredLabel`).

## MCP exposure and deferred discovery

MCP tools carry their server's `exposure` as Pi fields, from `mcp.ts`
([research](../../../docs/research/pi-codemode-mcp-design-2026-10.md)):
`codemode` (default) tools have `callers: ["tools"]`, so they are never declared
and are reached only from scripts; `deferred` tools are `deferred: true` and are
declared once `tool_search` loads them. Each server becomes a codemode
namespace (`mcp__<server>`, prefix `mcp__<server>__`) carrying its description
and instructions. Ordinary platform and execution tools remain direct.
Connections and `listTools()` still happen during runner construction; exposure
changes declaration, not network connection or authorization.

Every MCP tool declares a `CallToolResult` `structuredOutputSchema`. A script
receives the complete result (`content`, `structuredContent`, `isError`) as the
tool's `structuredOutput`, which Pi keeps only until the script settles; the
model-facing content of a direct call stays bounded and spilled.

Pi stores loaded names in the conversation's `pi.agent` `modelTools`, out of the
model's text, so they survive compaction and close/reopen. A run offers only
tools its grants enable, so a revoked grant is neither searched, offered, nor
callable from scripts; when the grant returns, its earlier discovery still
applies. Loading is not a second permission grant.

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
- `jev` reports a Jev with no provider key as a tool error, never a silent fallback.
- `jev` and `jev_browser` return the spend of their Jev and text-generation calls as the tool result's `usage`, so session spend and budgets count it; a call that throws reports none.
- `jev_browser` asks Jev which step to take, but Jev only chooses and scores, so the text it types or the option it selects is written by the conversation's own chat model (the office's resolved `settings.json` model), through pi-ai, which the runner injects. A field that needs text without that injection blocks with a reason instead of guessing.
- In `oci` mode, before each call `jev_browser` runs the sandbox image's `mikan-desktop status` (ADR 0025); other modes have no desktop and skip it. While the office desktop runs, the browser launches headed on its Wayland display, named by absolute path rather than through `XDG_RUNTIME_DIR`, because agent-browser keeps its session sockets under `XDG_RUNTIME_DIR` when it is set and a later call or the agent's own `agent-browser` without it would not find the session, and the tab limit counts only tabs the tool opened; while a person controls the browser it returns `person-has-control` without touching it, and the goal loop stops at the next step. A failed status call, as in an older image, means no desktop. `handOff` is used alone and only in direct messages, where its link can be sent privately; elsewhere it fails without touching control. It starts the desktop through the runner's `DesktopAccess`, and if agent-browser's lifecycle shows the browser was last launched headless, it reads the current page, closes the headless browser, and reopens that page on the desktop under a new session name (other tabs and the headless cookies are lost). The new name is needed because agent-browser's per-session daemon keeps the environment it started with, so a daemon started headless cannot launch Chromium on Wayland; the old daemon exits on agent-browser's own idle timeout. with no page open it fails and asks the model to open one with `url`, which now opens on the desktop. It then writes `control user`, posts the step with a private desktop link through the run's responder, and ends the turn with `terminate`; the presenter treats that result as the final response. If the post fails, control goes back to the agent.
- Each runner's `jev_browser` owns one browser, named by the tool rather than the model, that stays open until `close: true`; a later `url` opens a new tab, and opening past three tabs it opened first closes the oldest inactive ones of those, identified by target ID, so a tab a person opened on the office desktop is never closed. Model-named sessions each started another Chrome, and a few of them exhausted a 1 GB sandbox until every page load timed out. Every command, including cleanup, runs as an argv through the actor-resolved sandbox `ExecutionEnv`, and a missing `agent-browser` (`spawn_error`) is a provisioning error, never an automatic install or a host fallback.
- `web_fetch` runs on the host, so it refuses private, loopback, and link-local targets (ADR 0024). Its own undici `Agent` checks the remote address of every connection, which covers IP literals, DNS answers, redirects, and a name that resolves differently between requests. That `Agent` bypasses the daemon's global `EnvHttpProxyAgent`, because a proxy would make the connection and hide the target address, so a deployment that reaches the web only through a proxy cannot use `web_fetch`. Its result goes through `guardMcpToolResult`, the same bound and workspace spill as MCP results.
- `subagent.ts` owns the progress protocol that the presenter renders: snapshot bounds, parsing, merging, settling, and the Markdown dashboard.
