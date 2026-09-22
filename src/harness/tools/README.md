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

## Browser reliability

`jev_browser` carries a short, tool-specific native CLI guide instead of adding
browser rules to every agent's system prompt. It can read plain-text native
`--help` / `skills` output so advice matches the installed CLI. An obvious
`press @ref Enter` mistake is rejected before side effects; this is not a
second CLI parser. A raw batch stops at its first reported failure and skips
the goal loop. Separate essential capture exports if later commands must run
even when an earlier export fails.

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
