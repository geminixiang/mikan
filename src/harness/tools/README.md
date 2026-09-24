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

| Tool                    | Arguments | Final text/data | Image in result | `details` in session |                        Live progress                        | Data carried by the call/result                                                    |
| ----------------------- | :-------: | :-------------: | :-------------: | :------------------: | :---------------------------------------------------------: | ---------------------------------------------------------------------------------- |
| `read`                  |     ✓     |        ◇        |        ◇        |          ◇           |                              —                              | Path/range; file text or supported image content.                                  |
| `write`                 |     ✓     |        ✓        |        —        |          —           |                              —                              | Full text to write in arguments; write confirmation.                               |
| `edit`                  |     ✓     |        ✓        |        —        |          ✓           |                              —                              | Original/replacement text in arguments; diff/patch in result.                      |
| `bash`                  |     ✓     |        ✓        |        —        |          ◇           |                              ✓                              | Command in arguments; stdout/stderr and exit information.                          |
| `event`                 |     ✓     |        ✓        |        —        |          —           |                              —                              | Event payload in arguments; list/read data or write/delete confirmation.           |
| `sandbox`               |     ✓     |        ✓        |        —        |          —           |                              —                              | CPU/memory limits and status (supported on managed image sandboxes).               |
| `attach`                |     ✓     |        ✓        |        —        |          —           |                              —                              | Path/title and attached filename; not the file bytes as a result.                  |
| `generate_image`        |     ✓     |        ✓        |        —        |          —           |                              —                              | Generation request and attached filename; image stored/uploaded elsewhere.         |
| `react`                 |     ✓     |        ✓        |        —        |          ◇           |                              —                              | Emoji and reaction confirmation.                                                   |
| `jev`                   |     ✓     |        ✓        |        —        |          —           |                              —                              | State/questions in arguments; answers, model and usage in result.                  |
| `jev_browser`           |     ✓     |        ✓        |        —        |          —           |                              —                              | URL/commands in arguments; status, history, snapshot and raw command results.      |
| `start_task`            |     ✓     |        ✓        |        —        |          —           |                              —                              | Task target and admission confirmation.                                            |
| `task_status`           |     ✓     |        ✓        |        —        |          —           |              Session key and task status JSON.              |
| `slack_blockkit`        |     ✓     |        ✓        |        —        |          —           | Blocks/text in arguments; posted/updated message timestamp. |
| `github_pr`             |     ✓     |        ✓        |        —        |          —           |     PR request in arguments; operation status and URL.      |
| `github_checks`         |     ✓     |        ✓        |        —        |          —           |          Branch/job ID; check summary or job log.           |
| `github_review_reply`   |     ✓     |        ✓        |        —        |          —           |          Reply body in arguments; thread and URL.           |
| `github_sync`           |     ✓     |        ✓        |        —        |          —           |                   Branch and sync report.                   |
| `github_read`           |     ✓     |        ✓        |        —        |          —           |          Query and formatted PR/issue/review data.          |
| `github_issue`          |     ✓     |        ✓        |        —        |          —           |             Issue request and operation report.             |
| `subagent`              |     ✓     |        ✓        |        —        |          ✓           |                              ✓                              | Task/tool grants; final outcomes in text **and** `details`.                        |
| `mcp__<server>__<tool>` |     ✓     |        ✓        |        ◇        |          —           |                              —                              | Dynamic tool arguments; bounded compact server text (full result spilled), images. |

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

## Files

- `attach.ts`: Defines the platform-neutral `attach` tool and binds uploads through the active responder.
- `event.ts`: Defines the agent-facing `event` tool. The scheduled-event protocol, store, and watcher belong to `src/events/`.
- `generate-image.ts`: Defines the `generate_image` tool. It writes host-side into the office directory — the only host location the guest can also reach — and uploads from that host path directly, because the file may not be mounted in the sandbox the way `attach` assumes.
- `host-fn-tool.ts`: `defineHostFnTool` — the shared choreography for a tool whose implementation is injected per run (holder + setter pair, disabled-tool error, abort guard, and injecting the required `label` parameter every model-facing tool needs), so a host-backed tool module only states its schema and run body.
- `index.ts`: Assembles core tools — pi-native `read`/`write`/`edit`/`bash` plus mikan's event, sandbox, attach, react, jev, jev_browser (through the sandbox Executor), and optional generate_image — exports the separately wired subagent tool factory, merges optional `PlatformToolPack`s, and wraps the whole list with `withSecretRedaction`.
- `pi-tools.ts`: The mikan adaptation layer over pi-agent-core's native `read`/`write`/`edit`/`bash`: adds the `label` parameter, pins the bash cwd to the sandbox env, and adapts mikan's own `AgentTool`s into harness tools. The sandbox-backed `ExecutionEnv` they run against is `harness/execution-env.ts`.
- `jev.ts`: Defines the `jev` tool, a direct pass-through of the Jev decisions API (`harness/jev.ts`): the model supplies `state` and typed `questions` and gets calibrated answers back. A missing `OPENROUTER_API_KEY` is a tool error, not a silent fallback.
- `jev-browser.ts`: Defines the `jev_browser` tool, which controls a real Chrome browser. Two modes, combinable in one call: a Jev-driven goal loop (`evaluateWithJev`, `harness/jev.ts`, one calibrated CLICK/TYPE_TEXT/SELECT/SCROLL/WAIT/DONE/BLOCKED choice per step against ref-indexed accessibility snapshots — the same architecture as [`browser-use/jev-ultrafast`](https://github.com/browser-use/jev-ultrafast)), and a `commands` passthrough that forwards raw argument arrays straight to the [`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI, covering every capability the loop itself doesn't use (screenshot, `record start/stop`, `network har start/stop`, pdf, cookies, eval, etc.) without wrapping each one. A named `session` spans several calls against the same browser (e.g. start a recording, run a goal, stop the recording, screenshot the result) and stays open by default — only an explicit `close: true` or a one-off call with no `session` tears the browser down; requiring the caller to repeat an opt-in flag on every call in between (an earlier version's design) silently discarded in-progress recordings when that flag was forgotten under focus on the harder problem of what to click next, the way [`browser-use/jev-ultrafast`](https://github.com/browser-use/jev-ultrafast)'s single owned `Browser` object never needed one. The goal loop uses full snapshots so static completion text and iframe boundaries remain visible, and refreshes the snapshot after a step-limit action. Use `frame` with a CSS iframe selector or latest iframe `@ref` (or `"main"`) to delegate context switching to agent-browser before commands/the goal; a failed switch aborts instead of acting on parent refs. Refresh the snapshot after switching and use its new native refs; do not combine ref maps from multiple snapshots. In CLI 0.27.0, `eval` and CSS command selectors still address the top-level document, so frame selection is not a blanket scope for arbitrary commands. This does not guarantee every cross-origin/nested frame is supported by the installed CLI. Browser operations report `browserContinuity` from agent-browser's optional lifecycle metadata; absent or inconclusive metadata means unknown, not a failed command or a browser restart. Closing alone requires only `session` and `close: true` (plus the required `label`), and returns `status: closed` only after the CLI succeeds. Every command, including cleanup, goes through the runner's actor-resolved sandbox `Executor`; browser sessions and output paths live in that runtime and can be shared with its `bash` tool. Operators must provision `agent-browser` and its browser dependencies in the sandbox runtime/image. Missing dependencies produce a sandbox provisioning error, never an automatic install or host fallback. Explicit host sandbox mode uses its configured host Executor.
- `react.ts`: Defines the `react` tool (a `host-fn-tool`), which reacts to a message with an emoji through the platform bot.
- `secret-redaction.ts`: `withSecretRedaction` wraps every assembled tool so its text output is scrubbed of any configured secret env var's value (from `ENV_MANIFEST`'s `secret: true` entries) before it reaches the model or the session transcript — the only defense once host sandbox mode lets a shell command or file read return a secret in plain text. Mutates the tool's `execute` in place rather than copying the object, so `pi-tools.ts`'s `isHarnessTool` marker and a platform pack's `bindRun` binding to that same object both survive wrapping.
- `sandbox.ts`: Defines the `sandbox` tool for inspecting or changing managed sandbox resource limits.
- `subagent.ts`: Defines the `subagent` tool, which runs one fresh in-memory subagent, a bounded parallel `tasks[]` batch, or a small dependency DAG with explicit tools and budgets; node state streams through `AgentTool.onUpdate`. This module also owns the progress protocol: snapshot bounds, parsing, merging, settling, and canonical Markdown dashboard rendering consumed by the agent presenter.
- `types.ts`: The tool-side contracts for platform capability injection — `PlatformToolPack`, `PlatformToolPackFactory`, and `PlatformToolRunContext`.
