# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it leaves the 0.x line. While on `0.2.0-beta.*`, breaking changes may land in
any release.

## [Unreleased]

### Changed

- Codemode guides the model to discover every tool a task needs in one script and to parse MCP results and emit only the fields the answer needs, because everything a script emits is sent again on every later model call. `searchTools()` and `tool_search` rank with BM25 over names, descriptions, argument schemas, and the MCP server name, splitting camelCase like Pi, so a query such as `OpenConnector` finds `mcp__open-connector__*` tools; the default limit is 8.

## [1.0.0-beta.91]

### Changed

- MCP follows Pi's codemode design. MCP tools are reached from `codemode` scripts by default and `tool_search` exists only for servers configured with `"exposure": "deferred"`. A script receives each MCP tool's complete `CallToolResult` (`content`, `structuredContent`, `isError`) instead of the bounded view the model gets, so it can filter large results before they enter the context, and an MCP error resolves with `isError: true` instead of rejecting. The `codemode` description no longer repeats the declarations of tools already declared to the model; each of those tools' descriptions says what a script call resolves to. Server instructions are no longer copied into the system prompt: an `mcp_servers` section lists each server once with the first line of its new optional `description` or its instructions, and scripts read the rest with the new `describeNamespace()`. On a local request these changes cut the tool declarations from 38,274 to 26,538 characters and the codemode description from 14,232 to 2,803.
- A direct MCP call that the server marks `isError` returns an error result instead of throwing, keeping the server's message.

## [1.0.0-beta.90]

### Changed

- Run `mikan migrate` before starting this version. It deletes each office's `dream.json`, the checkpoint of the Dream maintenance removed in [ADR 0012](docs/adr/0012-remove-dream.md) that nothing reads, and makes every directory under `<state-dir>/conversations/` readable only by its owner (mode 700); links are not followed.

### Security

- An office's `events/` directory is created readable only by its owner (mode 700) instead of following the process umask.

## [1.0.0-beta.89]

### Breaking

- **Pi is upgraded to 1.0, and conversations now run on `@earendil-works/pi-durable`.** Pi 1.0 removed the harness, sessions, compaction, and coding tools from `pi-agent-core`; pi-durable is their first-party successor (see [ADR 0017](docs/adr/0017-pi-durable-harness.md)). Each office now keeps all its sessions in one SQLite storage, `sessions.db` in its State dir (see [ADR 0018](docs/adr/0018-one-durable-storage-per-office.md)); this needs Node 24.15 or later, whose built-in `node:sqlite` prints an experimental warning on load. Run `mikan migrate` before starting this version: it imports each office's v4 session files into that storage, the current main session as the top-level session and earlier main sessions and threads beside it, and moves the office's `sessions/` directory to `sessions-v4/`. An imported session keeps what the model could still see (the newest compaction summary and everything after it), its name, ID, and mikan's bookkeeping; history an earlier compaction had already hidden stays only in the archived files. Every office must be in `office-registry.json`. A tool call that was still running at upgrade is closed with an error result instead of being retried, and a run left unfinished is not resumed.
- `/new` resets the session in place: the model starts from an empty context, and the earlier history stays readable to the `history` tool and the session view instead of moving to a new session file.
- Library API: `createManagedSessionFile`, `createManagedSessionFileAtPath`, `createNewSessionFile`, `extractSessionSuffix`, `extractSessionUuid`, `getThreadSessionFile`, `openManagedSession`, `resolveManagedSessionFile`, `resolveSessionFile`, `tryResolveCurrentSession`, `tryResolveThreadSession`, `isPlatformHistorySession`, `CURRENT_SESSION_VERSION`, `MikanSessionHeader`, and `ChatSyncReport` are removed with session files; `SessionHeader` holds only `id`, `createdAt`, and `parentSessionId`; `registerThreadSession` and `hasMaterializedChatSession` are asynchronous, and `ResolvedSessionScope` no longer has `contextFile`.
- Library API: `SessionEntry` is mikan's own union of `message`, `custom`, and `compaction` entries, with IDs qualified by the session ID; `BranchSummaryEntry`, `CompactionEntry`, and `CustomEntry` are no longer exported. `SessionStore.createHarness` is replaced by `bindHarness`; `appendCustomMessageEntry`, the tree-era `getBranch`, `getLeafId`, `getEntry`, and `isPersisted`, and `SessionEntry.parentId` are removed; `SessionStore.getContextEntries()` returns the entries still in the model's context; and `MikanAgentSession.compactWhenNearLimit`/`cancelIdleCompaction`/`foldExternalUsage` are gone. `HarnessEvent` no longer mirrors pi-agent-core's `AgentEvent`: it drops `agent_start`/`agent_end`/`turn_start`/`turn_end`, replaces `message_update` with `text_delta`, and tool events carry `details` and a `{ content, details }` result. `MikanAgentSession.messages` and `reloadFromSession` are removed: the session keeps no transcript copy, so read the context through `SessionStore`, and a run's own messages through `lastRunMessages`. Harness tools use pi-durable's `execute(args, api, context)`; plain `AgentTool`s are still adapted.

### Added

- Slack and Discord mark a message with ⏳ when it waits behind a task that is still running, so a queued message no longer looks ignored.
- The agent gets a `history` tool, in every conversation, that lists the conversation's sessions (earlier ones replaced by `/new` and its threads), searches or reads them including tool calls and their output that `log.jsonl` does not keep, and searches the chat log; a query matches entries containing all of its words, and a Chinese or Japanese word also matches when most of its character pairs appear, so `暫時代號` finds `暫時註記：代號`. The system prompt tells the agent to answer from its own context when it can, and to look up a result its context lacks, such as a command's output from another session, instead of guessing or rerunning the command. It never reaches another conversation.
- `SENTRY_TRACES_SAMPLE_RATE` (0 to 1, default 1) sets how many traces go to Sentry when OTLP traces are not configured; an invalid value stops startup.

### Changed

- A new thread starts from what caused it. A thread under a channel answer, or under the message that triggered it, forks that run, so it carries the run's context up to its end, including tool calls and their output: asked what a command printed, the agent reads it instead of guessing or running it again. Any other thread starts from its root and its own replies, instead of ten earlier top-level messages copied from the chat log. Each run records the message that started it, and the chat log records each run answer with that message and its session.
- Chat history never appears as the agent's own turn: synced messages from other people, other bots, and mikan's notices enter a session as attributed chat lines, and an answer a run posted is left to its own session, so a Discord or Telegram reply answered in another session no longer leaks into the channel session.
- Compaction is Pi's: it runs in the background as the context grows and blocks the next request only near the limit, so mikan no longer starts its own compaction after a reply. Compaction summary requests now count toward a run's LLM-call and token budgets, and a request over the LLM-call budget is never sent.
- A run left unfinished by a crash or restart is aborted before the next message in that conversation instead of answering first.
- A thread session is named after the first line of its root message, cut to 80 characters, instead of the whole message; existing thread sessions take the short name on their next run.

### Fixed

- A one-shot event whose time passed while mikan was restarting or stopped now fires when mikan starts, instead of being deleted without running.
- Tool results that report `isError` reach the model as errors, so a failing codemode script is no longer recorded as a success.
- A run stopped before the model wrote anything no longer stores a made-up aborted answer, and its reply is never taken from the previous run.
- Compaction entries in the session view and subagent parent context show the summary itself, without Pi's wrapper text, and a subagent's parent context keeps the messages Pi retained after compaction.
- A run Pi settles with a model error is recorded as failed instead of completed.
- The usage summary's context size follows Pi's rule, the newest successful answer after the latest compaction, so it no longer reports the pre-compaction size, and it is omitted until a new answer measures it.

## [1.0.0-beta.88]

### Added

- `tool_search` discovers authorized MCP tools and loads matching schemas for the next model call. MCP connections still start as before, but tools are no longer all declared upfront. Loaded tools survive later prompts and session reopen, subject to current grants. Codemode gains `searchTools()` and omits MCP schemas from its inline description.
- `codemode` runs JavaScript through Pi's official QuickJS sandbox to combine authorized tools and filter results before returning them to the model. Existing direct tools remain available; nested calls honor per-run grants, loop guards and cancellation, and appear in progress and tool-call counts. Sessions without tools stay tool-less.

### Fixed

- Codemode follows Pi's model-facing helper guidance and generates asynchronous global declarations from the same definitions used by the official sandbox. `searchTools` and `describeTool` are explicitly global functions called with `await`; their complete declarations remain available even when the nested tool catalog exceeds its inline budget. Discovery uses Pi-generated tool samples with declared output schemas and its text-result default, so scripts can distinguish JSON text from structured values.

## [1.0.0-beta.87]

### Fixed

- `mikan migrate` moves the per-thread session directories that early versions left inside `sessions/` to the state directory intact, instead of stopping with `Unexpected entry in sessions directory`. Links inside them are moved as links and never followed.

## [1.0.0-beta.86]

### Breaking

- **The GitHub adapter now runs as a bound GitHub account driven by webhooks, and no longer uses a GitHub App or polling.** People mention it with autocomplete, assign it issues and pull requests, and request its review. Set `GITHUB_AGENT_TOKEN` (a fine-grained PAT of that account), `GITHUB_WEBHOOK_SECRET` (an organization or App webhook to `<LINK_URL>/github/webhook`), and `GITHUB_REPOS` (now required: `owner/repo` or `owner/*`); the link server must run. `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_PRIVATE_KEY_PATH`, and `GITHUB_POLL_INTERVAL` are removed, `@<app-slug>` no longer triggers, and `<state-dir>/github-sync.json` is no longer read and can be deleted. Deliveries are best effort: events sent while mikan is down are not replayed. See [ADR 0015](docs/adr/0015-github-agent-account-and-webhooks.md) and [Make mikan a GitHub teammate](src/content/docs/github-teammate-guide.md).
- **The GitHub adapter is restricted by default.** It answers only in private repositories listed in `GITHUB_REPOS`, only to people with write permission, and only comments and reads. `GITHUB_CAPABILITIES=triage,push` restores label and assignee management and pull requests; `GITHUB_PUBLIC_REPOS`, `GITHUB_USERS`, `GITHUB_MIN_PERMISSION`, and `GITHUB_TRIGGERS` narrow or widen who can trigger it and how.
- `github_checks` reads GitHub Actions jobs and commit statuses instead of check runs, because fine-grained PATs have no Checks permission. Check runs from third-party CI apps are no longer visible.
- **mikan no longer runs git for GitHub conversations.** Nothing is cloned into `<office>/repo`, and `github_sync` is removed. The agent clones, commits, and pushes inside its sandbox with the sandbox's GitHub credentials, and `github_pr` only opens a pull request for a branch the agent already pushed. What the agent can push is now bounded by that token, the account's repository role, and branch protection instead of mikan's `pi/*` rule; protect the default branch. GitHub conversations now trust `membership`, because only collaborators with write access can trigger them, so they receive `sandbox.defaultSharedVault` and settings-declared MCP servers like Slack conversations.
- **Session files move from `<workspace>/<office-key>/sessions/` to `<state-dir>/conversations/<office-key>/sessions/`, and sandboxes no longer see them.** Run `mikan migrate` before starting this version. The agent searches earlier history in `log.jsonl`, which stays in the office directory. See [ADR 0016](docs/adr/0016-host-sandbox-trust-boundary.md).
- Library API: `officeSessionsDir` and `resolveChannelSessionFile` are removed; use `office.sessionsDir` and `tryResolveCurrentSession(office.sessionsDir)`. `getThreadSessionFile` and `resolveParentSessionForThread` take the sessions directory, and the `ChatHistorySync` options and `registerThreadSession`/`hasMaterializedChatSession` take `office` instead of `conversationDir`.
- `jev_browser` no longer takes a `session` parameter. Each conversation thread has one browser that stays open across calls until `close: true`; a later `url` opens a new tab, and opening past three tabs closes the oldest inactive tabs and reports them in `closedOldTabs`. Model-named sessions each started another Chrome, and a few of them exhausted a 1 GB sandbox until every page load timed out.

### Changed

- Pi is upgraded from 0.87 to 0.99 (`pi-agent-core`, `pi-ai`).
- MCP servers now connect through Pi's `@earendil-works/pi-mcp` client instead of the official `@modelcontextprotocol/sdk`, which is removed along with `zod`. Stdio servers still receive only a minimal inherited environment plus their configured `env`. When an HTTP server rejects the connection, the error now carries the status and the start of the server's response body.

### Added

- GitHub issue and pull request conversations receive the default OpenConnector runtime token like Slack conversations, named `mikan:github:<conversation-id>`.

### Fixed

- `models.json` follows `--state-dir` / `STATE_DIR` like `settings.json`; the daemon, `mikan migrate`, and `mikan onboard` no longer read or write `~/.mikan/models.json` for another state directory.
- A daemon adopts at startup only the sandbox containers that mount its own workspace, so two mikan instances sharing one Docker engine no longer stop each other's containers.
- The sandbox image now ships CJK fonts (`fonts-noto-cjk`, about 170 MB). Without them, `jev_browser` screenshots showed Chinese and Japanese text as blank space, and charts drawn in the sandbox could not use Chinese labels.
- Python packages in the sandbox go through uv. The system pip still refuses installs, but its message now names the uv commands to use (`uv run --with <package>`), so the agent recovers after one attempt instead of trying pip, venvs, and apt in turn. The docs no longer claim that `pip install --user` works.
- Creating or updating a periodic event now reports its next three runs in the event's timezone, so the agent no longer computes weekdays itself (it once announced a Monday reminder for a Tuesday). An invalid cron `schedule` or `timezone` is rejected before the event file is written instead of being saved and then skipped by the scheduler.
- `apt-get install` works inside managed sandbox containers again. The containers drop all capabilities, so apt's download sandbox user could not switch groups and every install failed; the image now runs apt downloads as root, and the image smoke test installs a package under the same hardening.
- Asking "好了嗎" at the moment a background task finishes no longer answers "還在處理" right beside the completion notice. Task status now trusts the recorded end of the run over the runtime's still-settling state.
- A Slack message whose acknowledgement was lost during a socket reconnect no longer runs twice. Slack redelivers such events; mikan now recognizes a message or mention it has already taken and ignores the copy. A failed acknowledgement is logged instead of surfacing as an unhandled promise rejection.
- A Slack app that is not an agent app no longer calls `assistant.threads.setSuggestedPrompts` and logs `not_agent_app` every time someone opens its DM; after the first refusal the call is skipped until restart.
- A long Slack answer that outgrew the native stream no longer shows up twice. The partial streamed message is deleted before the full answer is posted, and the notification text sent with it is capped at the 4,000 bytes `chat.update` accepts, so the edit no longer fails with `msg_too_long`.
- A long Slack answer with many headings no longer fails with `invalid_blocks` and an `Error:` line. Slack expands each heading of a markdown block into its own block and rejects a message with more than 50; when an answer would exceed that, its headings are sent as bold lines instead.
- MCP tools ask the model for a progress label like every built-in tool, so the Slack checklist shows a readable step (for example "確認 GitHub 連線") instead of `mcp__server__tool`. The label is not forwarded to the MCP server, and a tool that already has its own `label` argument is left unchanged.

## [1.0.0-beta.85]

### Breaking

- **State migrations run only through `mikan migrate`.** The daemon now refuses to start while a migration is pending, and prints the exact command to run. It no longer moves anything at startup or on first read. After installing a new version, run `mikan migrate --sandbox=<the daemon's --sandbox> --dry-run`; if anything is pending, stop the daemon, run the same command without `--dry-run`, then start it. Applied migrations are recorded in `<state-dir>/migrations.json`, and `mikan onboard` marks a new state directory as fully migrated. See [ADR 0014](docs/adr/0014-versioned-state-migrations.md).
- **Removed commands:** `mikan office claim`, `mikan office migrate-openconnector`, `mikan office migrate-events`, `mikan office migrate-door-policy`, `mikan sessions migrate`, and `mikan sandbox status|diff|migrate`. `mikan office list` remains and now prints each office key with its platform and conversation id.
- **Upgrades are supported only from 0.5.3.** Formats that existed only in 1.0.0 prereleases are no longer converted: OpenConnector `open-connector-runtime-token.json` files, door-policy settings, Pi 0.84 session files, `<state-dir>/conversations/<raw-id>` directories, and the hashed legacy vault keys. A prerelease install that already ran those conversions is unaffected.
- **Sandbox containers are disposable.** A managed container has no home volume. When its image or mounts change, it is replaced once it is stopped, and only the workspace and vault mounts carry over. Anything else, including `/root`, installed packages, and caches, starts empty. Existing `mikan-home-*` volumes and `mikan-migrate:*` images are no longer used, and operators may delete them.
- **Host and container vaults use hashed keys only.** The runtime no longer falls back to vault directories named by raw user id (`host`) or `container-<name>` (`container:*`). `mikan migrate` renames them.
- The public API no longer exports `findV3SessionFiles`, `isV3SessionFile`, or `migrateSessionFile`.

### Changed

- When a scheduled run hits its budget, the stop notice now says how long it ran, how many model and tool calls it made, the slowest steps with their durations, and which step was still running. Slow queries can be found from the notice alone.

### Fixed

- Multi-line error notices in Slack are italicized line by line, because Slack emphasis does not span line breaks.
- Upgrading a 0.5.3 install keeps each conversation's credentials. The old startup migration looked for a vault name that 0.5.3 never wrote, so 0.5.3 conversation vaults were silently left behind; `mikan migrate` moves them to their office keys.
- Upgrading a 0.5.3 install removes its sandbox containers instead of recreating them from snapshots under their old names next to the new ones.

## [1.0.0-beta.84]

### Performance

- Shorten the `jev_browser` tool definition from about 7,000 to 2,800 characters sent on every turn: its description and parameters no longer repeat each other or explain rules the tool already enforces with its own error messages.
- List skills in the prompt one line each under their directory instead of an XML block with a full path per skill; a path appears only when a skill's directory differs from its name. A workspace with 68 skills drops from about 31,000 to 22,000 characters of prompt per turn with the same names and descriptions.

## [1.0.0-beta.83]

### Fixed

- Stop copying each mikan reply back into the session a second time: chat history sync compared the posted reply, which carries the `_Triggered by …_` signature, against the model's unsigned text, missed the match, and appended the signed copy. Context held every answer twice and taught the model to keep writing the signature. Imported bot messages are now compared and stored without the signature, and a posted reply that opens with the tool checklist is matched to the model's answer it ends with.

## [1.0.0-beta.82]

### Changed

- mikan reacts `saluting_face` (eyes on GitHub) itself when a run starts its first work tool, instead of the model spending a separate round on the reaction; the model's `react` tool is left for background checks with nothing to report.
- mikan owns the `_Triggered by …_` signature on chat responses and replaces any signature line the model wrote, so user messages no longer carry a per-turn attribution instruction. The model is still asked to sign GitHub text it writes itself.
- The model reads the current time from each message's send time instead of running `date`.

## [1.0.0-beta.81]

### Added

- Stream every run of a session live in Session View: a run started from Slack or another chat platform now appears on an open page as it happens (user message, tool results, the streaming answer), then the timeline reloads. Page-sent messages use the same stream; thinking text and errors appear after the timeline reloads.
- Guard tool loops: repeating the same tool call with identical arguments earns a notice from the third call, is blocked from the fifth, and stops the run at the tenth; short repeating cycles of calls also earn a notice.
- Compact a session in the background after a successful run when its context nears the compaction threshold, so the next message does not wait for compaction.

### Fixed

- Undo Slack's HTML escaping on incoming text: the model and the office log saw `&amp;&amp;`, `&lt;`, and `&gt;` where the user typed `&&`, `<`, and `>`.
- Keep the tool checklist visible while the final answer streams; it used to disappear until the answer finished.
- Stop an open Session View page from holding shutdown open; open live streams now close after a five-second grace, so a restart no longer waits for the process manager's kill timeout.
- Report a GitHub API request that returns an empty body where a resource is required with its method, path, and status, instead of failing later on a null value.

### Security

- **Breaking (deploy):** The link server (Admin, Session View, and credential links) now listens on `127.0.0.1` even when `LINK_URL` is set; it used to listen on every interface, so portal tokens could travel in plain HTTP straight to `LINK_PORT` around the TLS reverse proxy. A reverse proxy on the same host (`reverse_proxy 127.0.0.1:8181`) keeps working unchanged. Set the new `LINK_HOST` (for example `0.0.0.0`) when the proxy runs on another host or in a separate network namespace.

## [1.0.0-beta.80]

### Fixed

- Post no Slack usage summary for a `[SILENT]` response: the reply and its thread were deleted, so the summary for a quiet recurring event landed at the top level of the channel on every run.
- Stop warning `Could not remove snapshot image mikan-migrate:...` for every migrated container on each startup; the startup sweep now leaves a snapshot alone while its container still runs from it, and still reclaims snapshots no container uses.

## [1.0.0-beta.79]

### Changed

- Load the Discord adapter and `discord.js` only when Discord is active, saving about 38 MB of memory and 90 ms of startup in processes that do not run Discord.
- Use pi's `typebox` 1.3.27 for tool and settings schemas instead of the incompatible `@sinclair/typebox` 0.34; platform tool packs now share pi's `AgentTool` schema types. Schema validation errors retain field paths but use typebox 1's wording.
- **Breaking (SDK):** `new ChatHistorySync()` now requires `{ isCommandText }`, so sessions no longer import the command inventory from the adapters. Pass the newly exported `isCommandText` to keep filtering command messages out of synced history.

### Security

- Only send the Slack bot token to `https://*.slack.com` file URLs, and stream incoming attachments to disk with a 100 MiB limit instead of buffering whole files in memory; a download over the limit is rejected, not retried, and leaves no partial file.

### Fixed

- Reject missing sandbox helper executables as ordinary `ENOENT` errors instead of emitting an unhandled child-process error.
- Accept `thinking: max` in subagent profiles; they kept their own level list without `max`, while settings and `/pi-model` accepted it.
- Spill oversized MCP JSON results as indented JSON so `read` and `grep` can inspect them; the compact single-line spill exceeded `read`'s per-line limit.
- Record a Discord channel without a name (such as a DM) under its channel id instead of a `null` name.

### Tests

- Type-check tests, E2E code, and the embedder example in pre-commit and CI, and remove every `any` and double assertion from tests.
- Run tests in random order and print the seed, so order-dependent tests fail visibly and can be reproduced.

## [1.0.0-beta.78]

### Added

- Capture durable knowledge after each settled human run: Jev gates the exchange, and the conversation's model adds or updates stamped lines under `## Captured knowledge` in the conversation `MEMORY.md`; configured secrets are redacted from captured entries (ADR 0011).
- Give each new managed image container a per-office home volume (`mikan-home-<key>`) at `/root`. A stopped container whose image or mounts are stale is recreated from the current image with the same volume, so `/root` survives image upgrades; running containers are never interrupted (ADR 0009).
- Add `mikan sandbox status|diff|migrate` to inspect managed containers and move legacy containers onto a home volume with the daemon stopped.

### Changed

- Bound MCP tool results like `bash`: JSON is re-serialized compactly, oversized results become a structural digest (keys, counts, and pagination kept) within Pi's 50KB/2000-line limit, and the full result is spilled to `.mikan/mcp-output/` in the runtime workspace. `structuredContent` is used when `content` is empty, binary resources are no longer inlined, error text is bounded, and MCP results pass through secret redaction.
- Shared top-level channel sessions no longer rotate every two weeks; they stay current until `/new`, and Pi's automatic compaction bounds the model context (ADR 0010).
- The sandbox image installs its runtime outside `/root` and is published only with mikan releases.
- Document the Vault as the store for development credentials that sandbox programs read directly; OpenConnector is the path for third-party service access (ADR 0013).

### Removed

- Remove scheduled Dream memory maintenance. Conversation `MEMORY.md` is written only by the agent and by post-run memory capture; existing `dream.json` checkpoints are no longer read (ADR 0012).

## [1.0.0-beta.77]

### Added

- Provision the standard sandbox image with Node.js 24, Chromium, ffmpeg, pinned `agent-browser` 0.38.1, and a checksummed Google Workspace CLI so `jev_browser` and capture workflows work without runtime installation and current-page recording preserves hydrated browser state.

### Changed

- Run every `jev_browser` command through the conversation-authorized sandbox executor, preserve native snapshots, refs, frames, tabs, screenshots, HAR, and recording, serialize calls per runner, and make named-session continuity and close-only operations explicit.
- Bound autonomous browser failures and repeated action cycles, refresh current page evidence before reporting completion, and refuse to silently resurrect an explicitly closed named session as `about:blank`.
- Delegate persisted session behavior to public Pi session and harness APIs instead of maintaining duplicate storage semantics.

### Fixed

- Log LLM cancellation reasons and Pi run ids only while provider transport is active, avoiding false abort logs during authentication, payload hooks, retry waits, tool execution, or after structural requests finish.

### Security

- Harden state and credential ownership by preserving explicit vault mount targets outside secret directories, rejecting migration collisions, keeping private file writes atomic, and deriving session operations from authorized conversation identities.

## [1.0.0-beta.76]

### Changed

- Update `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` to 0.87.0, including their aligned telemetry and harness dependencies.

## [1.0.0-beta.75]

### Added

- `jev_browser` agent tool: drives a real Chrome browser toward a natural-language goal, deciding each step (click, type, select, scroll, wait) itself using a Jev decision per step against ref-indexed accessibility snapshots — the same architecture as [`browser-use/jev-ultrafast`](https://github.com/browser-use/jev-ultrafast). A `commands` mode forwards raw [`agent-browser`](https://github.com/vercel-labs/agent-browser) CLI argument arrays directly, covering screenshot, video recording, HAR capture, cookies, and any other agent-browser capability beyond the click/type/select loop. A named `session` spans multiple calls against the same browser (start a recording, run a goal, stop the recording, screenshot the result) and stays open by default; every result reports `browserContinuity` in plain language so a caller can tell whether the browser it just used was actually the same one a prior call left open. Tool progress lines are prefixed `jev_browser ·`, matching the existing `jev ·` treatment. Requires the `agent-browser` CLI installed on the host (not a mikan dependency); host sandbox only.
- Jev decision cost (from the `jev` tool, `jev_browser`'s decision loop, Slack auto-reply gating, and task-intent classification) is now reported to Sentry/OpenTelemetry as `agent.jev.cost`, `agent.jev.duration`, and `agent.jev.calls`, tagged by which feature made the call. Previously this spend was invisible next to the primary chat model's per-run cost — it only ever appeared inside a tool call's raw JSON text.

### Changed

- Every agent tool now requires the `label` parameter the system prompt already promises for every tool call, so its progress line always shows a real description instead of silently falling back to the raw tool name.

## [1.0.0-beta.74]

### Security

- Host sandbox tool output (bash, read, and every other agent tool) is now scrubbed of any configured secret env var's value before it reaches the model or the durable session transcript. Host sandbox mode does not isolate environment variables, so a command like `echo $OPENROUTER_API_KEY` previously returned the key in plain text with no defense beyond the model choosing not to repeat it; it is now replaced with a `[SECRET:VAR_NAME]` placeholder using mikan's existing secret env var inventory.

### Fixed

- Stop and shutdown-restart notices ("Stopping…", "Stopped.", the restart notice) are now recorded in the conversation's `log.jsonl`, matching every other agent reply. Previously these control messages reached the platform but left no trace in the human-readable history the agent (and operators) grep, so a stopped run looked, on later review, like it had never been interrupted.

## [1.0.0-beta.73]

### Changed

- Admin: redesigned the page around a persistent icon sidebar and a single active settings pane (Claude/ChatGPT settings-app style), replacing the pill-tab-plus-accordion layout. Conversation and workspace scope each get their own rail; every pane shares one quiet header (title, one-line description, actions) instead of a stack of bordered cards. Widened the page from 960px to 1180px so the sidebar-plus-pane layout has room to breathe.

## [1.0.0-beta.72]

### Added

- Admin: the Skills panel (conversation and global) can now create, edit, and delete skills directly, not just list and preview them. Saving writes `SKILL.md` straight into the workspace skills tree the harness loader reads, so a new or edited skill is available on the conversation's next turn.

## [1.0.0-beta.71]

### Changed

- Built-in subagents now use the full 100-turn / $10 allowance, and the model-facing `subagent` tool can only request a larger token allowance instead of accidentally shrinking turn, cost, or duration budgets (for example, to $0.30).

### Fixed

- Shared-memory guidance now keeps personal, project-specific, and tool-specific knowledge in its proper scope, prevents memory from overriding system mechanisms, and removes the obsolete shared `SYSTEM.md` environment log.
- Console usage summaries now show cache-read tokens alongside fresh input tokens.
- Sandbox provisioning no longer logs `Container … already running` on every readiness check; creation, restart, drift, and failure messages remain visible.

## [1.0.0-beta.70]

### Fixed

- Sandbox: a container migrated to the office-key mount layout (or recreated after its mount configuration drifted) no longer re-migrates on every subsequent restart. The one-time bridging snapshot image is now removed once the new container is confirmed up, instead of being kept forever on the mistaken assumption that the container would eventually run from the base image again. In production this had pinned dozens of containers to increasingly stale snapshots and left their images unreclaimed, consuming disk space on every restart.

## [1.0.0-beta.69]

### Changed

- `harness/jev.ts` is now backed by [`@geminixiang/jev`](https://github.com/geminixiang/jev), a standalone SDK shaped like pi-ai (providers own auth, a model catalog, and a wire implementation) instead of a hand-rolled OpenRouter fetch client. `evaluateWithJev`'s signature, types, and error classes are unchanged, so the auto-reply gate, DM task-intent classification, and the `jev` tool are unaffected. The swap adds request retries and timeouts, neither of which existed before, and a path to other Jev backends (TypeSafe, Vercel AI Gateway, Cloudflare Workers AI) without touching call sites.

## [1.0.0-beta.68]

### Added

- `jev` agent tool: the model can now call Jev directly with a `state` (text or JSON) and any number of boolean / choice / score `questions`, mirroring the decisions API one-to-one — structured instructions and criteria, per-option probabilities, confidence, and score legends all pass through. Available to the main agent and to the `worker`, `software-engineer`, `data-scientist`, and `summarizer` subagent profiles. A missing `OPENROUTER_API_KEY` is reported as a tool error so the model judges for itself.
- Slack: DM messages in a task thread (and top-level DMs while a task is running) are classified by Jev as `status`, `steer`, or `request` before spending a model turn. Status questions are answered from recorded task state; steering is delivered into the running task; anything else starts a normal run. The regex status matcher remains as the fallback.
- `task_status` reports `queued` for tasks that were admitted but have not started executing yet.

### Changed

- `harness/jev.ts` accepts structured JSON for state, instructions, and criteria, and returns `confidence` and `legend` on choice / score answers.
- Jev auto-reply and task-intent state renders `<@U…>` mentions as `@Name` (the bot as `@mikan`) so Jev can tell a message addressed to someone else from one addressed to mikan.
- Tool progress lines for `jev` calls are prefixed with `jev ·` so users can see which steps came from a calibrated judgment.

## [1.0.0-beta.67]

### Changed

- Slack: unaddressed thread replies in shared channels now pass through the same `/pi-auto-reply` gate as top-level messages instead of being dropped unconditionally. In `jev` mode, Jev scores the message together with its surrounding scope (the channel's recent top-level messages, or the thread's messages plus whether mikan has already replied there), so bare follow-ups like "then roll it back" are judged in context. `off` still requires a mention; `on` now admits thread replies too.
- Deploy docs: `/pi-auto-reply` slash command description lists `on | off | jev`.

## [1.0.0-beta.66]

### Added

- `/pi-auto-reply` gains a third state, `jev`: alongside manual `on`/`off`, a Slack channel can now delegate the "does this unaddressed message address mikan" decision to Jev (`typesafe/jev`), a fast typed-decision model, on a per-message basis. Any evaluation failure (including a missing `OPENROUTER_API_KEY`) fails closed to "not addressed" so a misconfiguration cannot make the bot noisy in a shared channel.
- `harness/jev.ts`: a standalone `evaluateWithJev` client for Jev, reached through OpenRouter's `/api/alpha/decisions` REST API using the same `OPENROUTER_API_KEY` pi-ai's `openrouter` chat provider reads. Jev returns typed decisions (boolean probability, choice, score) instead of generated text, so it is a plain function call sites use directly rather than a selectable chat provider in `models.ts`'s catalog.
- Jev-mode auto-reply decisions (channel, probability, addressed, truncated message text) are logged at info level for observability.

## [1.0.0-beta.65]

### Added

- Slack: when a run resolves to exactly one completed subagent profile with a known persona, the final answer posts as a fresh message under that profile's own username/icon (`Data Scientist`, `Software Engineer`, `DevOps Engineer`, `Account Manager`, `Business Development`, `Creative Producer`, `Ad Operations Specialist`) instead of mikan's own identity. Mixed-profile or partially-failed runs keep mikan's identity, since `chat.update`/`chat.appendStream` cannot carry a Slack identity and there is no single "who answered this" to attribute.
- The `react` tool (add an emoji reaction to the triggering message) is now documented in the system prompt with two unconditional triggers tied to `start_task`'s existing bar: react before starting any multi-step investigation, change/test, or long wait, and react instead of writing "nothing to report" on a periodic/background check with nothing to report.
- Discord and Telegram now wire the `react` tool into their responders (previously Slack/GitHub-only despite the tool being granted everywhere); a shared short-name-to-Unicode translation covers what the prompt recommends for platforms whose reaction API takes a Unicode character rather than a name.
- `creative-producer` subagent profile gains the `generate_image` tool grant, matching its image-deliverable description.

### Changed

- Built-in subagent profile `maxTokens` raised from 100,000 to 1,000,000: the old cap was a common budget-exceeded trip for ordinary investigative tasks (e.g. a repo-wide architecture review), not just runaway loops.
- The `analysis-only` subagent profile is renamed `summarizer`: it is a DAG synthesis node over upstream dependency output, not a mid-task advisor.
- Office data policy for non-Slack platforms is now an explicit rule (ADR 0008): only Slack conversations can be public, and Telegram/Discord/GitHub offices always resolve to private rather than falling through an "unknown" branch by omission.
- The Admin office visibility card now states the effective outcome in plain words instead of the internal policy model; public Slack channels get one "Hide the files in this channel from other offices" checkbox, other conversation kinds show the fixed Hidden state with no control.
- `settings.json` ownership (schema, scope merge, readers, writers, one-time migrations) is gathered under `src/settings/`.

### Docs and maintenance

- Describe mikan as an organization-wide, per-conversation-isolated agent.
- Move the three remaining top-level source files into their owning modules (`adapters/messages.ts`, `adapters/index.ts`, `cli/process-lifecycle.ts`); pure move, no behavior change.

## [1.0.0-beta.64]

### Changed

- The retired door-policy keys (`sandbox.image.workspaceMount`, `sandbox.workspace`) are dropped at load time and no longer appear in the resolved sandbox settings or the Admin office view.

### Added

- `mikan office migrate-door-policy` removes the retired keys from the global and every registered office settings file, preserving all other settings and leaving files without them untouched. Only an explicit shared-support `private` visibility is carried into `office.visibility`; `full`, `isolated`, and legacy `private` are removed without deriving any grant.

## [1.0.0-beta.63]

### Changed

- Office data policy is now a single **visibility** derived from the Slack conversation type (ADR 0008): public channels are public offices; private channels, DMs, group DMs, externally shared channels, and unknown kinds are private. Every office receives the same projection — its own directory read-write, every other public office read-only under `/workspace/public/<office key>`, and shared `MEMORY.md`/`skills/` read-write for public offices or read-only for private ones. Nothing mounts the workspace root.
- The five-way door policy (`isolated`, `trusted/shared-support`, `trusted/full`, …) is retired. Legacy settings still parse but no longer change the projection; offices that still declare `full` are reported once per process. The Admin "door policy" control and `/pi-sandbox door` are replaced by one switch that can narrow a public channel to private (`/pi-sandbox visibility <private|default>`); nothing can widen beyond what Slack allows.
- Backends without a managed projection (`host`, `container:*`, `cloudflare:*`) now serve private offices with a one-time logged warning instead of refusing, since they are trusted deployments by definition.

### Added

- The Slack adapter records channel kinds for every registered office from the channel list loaded at startup, so offices created before kinds were recorded keep their public status without waiting for a new message.

### Fixed

- Recreating a sandbox container after a visibility change removes empty `/workspace/public/<key>` mountpoints that `docker commit` carried over from the previous mount set.

## [1.0.0-beta.62]

### Changed

- Scheduled events now live in host-only per-office state (`<state dir>/conversations/<office key>/events/`) and are never mounted into a sandbox. The `event` tool and the Admin portal are the only writers, both confined to the current office; `create` never overwrites, deleting a record cancels its timer or cron immediately, and the Slack App Home lists only the opener's DM office schedules. The filesystem watcher is gone: hand-edited records take effect on the next start.
- OpenConnector is an ordinary MCP server with a deployment default. When a Slack conversation has not declared `open-connector`, mikan mints that conversation's runtime token with `OPENCONNECTOR_ADMIN_TOKEN` and saves a normal `mcpServers` entry in its settings; conversations may override it with a self-hosted server or disable it like any other MCP entry. The loader no longer fills `connectionName`; connection selection belongs to OpenConnector.

### Added

- `mikan office migrate-events` moves legacy `<workspace>/events/*.json` records into the owning office's state and reports records it cannot attribute.
- `mikan office migrate-openconnector` converts legacy `open-connector-runtime-token.json` files into conversation MCP entries.

### Fixed

- The agent `event` tool can no longer list, read, update, or delete another office's events, and `scope=all` is rejected.

### Docs and maintenance

- Redraw the architecture diagram as a single rounded page and refresh the README image.
- Support local Slack E2E runs, capture intake and session markers on failure, and schedule E2E events through the `event` tool instead of writing files.
- Record the Office isolation policy, storage inventory, and OpenConnector history audit under `docs/`.

## [1.0.0-beta.61]

### Added

- Ground Slack DM progress replies in runtime/v4 task observations; common task-thread status queries no longer steer work, and ordinary followups do not repeat completion mentions.
- Slack DM task handoff: independent task threads keep the main conversation free, with text steering in active task threads and continuation after stopping.

### Fixed

- Keep thread stop acknowledgements in the source thread, including shared-channel unmentioned stop controls.
- Notify Slack DM task requesters with a fresh in-thread mention after normal completion.
- Finalize stop acknowledgements that arrive after the cancelled run has already settled.
- Propagate final response delivery failures so rejected updates do not trigger completion notifications.
- Honor stop during runner preparation and keep older active tasks visible in status queries.
- Report task admission, asynchronous startup, and status inspection failures through the existing Sentry/OTLP observability path.

### Changed

- Publish the already built and verified npm package without rerunning build and repository setup lifecycle scripts.
- Keep the documented and CI coverage commands as stable entry points while maintaining their shared Vitest invocation in one place.
- Validate debug Session View selections from their path and header, leaving full parsing to consumers that load session content instead of inspecting the same file twice.

## [1.0.0-beta.60]

### Fixed

- Separate CJK-adjacent bold dollar amounts for Slack's Markdown parser while preserving code and link destinations.
- Validate Session View selections through read-only inspection so active and repeatedly selected historical sessions do not conflict with writer ownership or appear corrupted.

## [1.0.0-beta.59]

### Fixed

- Keep Slack's working indicator in its own paragraph so progressive heading and table updates can replace existing rich-text messages without `block_mismatch`.
- Pace failed progressive redraws as well as successful ones, retaining accumulated text for recovery instead of retrying on every delta.

### Changed

- Use Commander for CLI option parsing, subcommand validation, and generated help.
- Guide interactive onboarding with arrow-key selections, masked credentials, and a final confirmation before saving. Cancel without writing settings.
- Refuse custom-provider onboarding when models.json already exists, without printing credentials or writing partial settings.

## [1.0.0-beta.58]

### Added

- Restore Slack `/pi-auto-reply on|off` with the original per-conversation marker files, without judge models or rules.
- Expose the admin portal command on Discord and Telegram.

### Changed

- Collapse conversation sections in the Admin portal, load their data only when opened, remember their open state, and open Vault and Session View links in new tabs.

## [1.0.0-beta.57]

### Changed

- Export raw platform conversation, channel, session, thread, message, and user identifiers so Sentry traces can be mapped directly back to their source while continuing to exclude human-readable names and conversation or tool content.

### Removed

- Remove telemetry identifier hashing and the `TELEMETRY_HASH_KEY` deployment setting.

## [1.0.0-beta.56]

### Added

- Add content-free agent diagnostics for actual model IDs, token and cost totals, first-token latency, context utilization, message and attachment counts, payload sizes, tool categories and status, and retry, compaction, and budget summaries.

### Security

- Replace raw conversation, session, message, thread, and user telemetry identifiers with stable opaque values, support deployment-specific HMACs through `TELEMETRY_HASH_KEY`, and stop sending usernames to Sentry.

## [1.0.0-beta.55]

### Added

- Export explicitly configured, content-free traces and metrics over standard OTLP HTTP/protobuf, including GenAI and OpenInference attribution for Arize Phoenix. Sentry remains available for sanitized issues and legacy metric fallback without duplicate spans; zero configuration remains network-free.
- Add a guided Admin dialog for configuring MCP servers, with structured fields or pasted standard `mcpServers` JSON and card-based installed-server management.

### Changed

- Delegate the agent run loop, retries, compaction, persistence, cancellation, and the native `read`, `write`, `edit`, and `bash` tools to Pi's `AgentHarness` and execution-tool implementations. mikan retains budgets, platform presentation, authorization, and sandbox-backed execution routing.
- Upgrade `pi-agent-core` and `pi-ai` to 0.85.1, including GPT-6 Astra catalog entries and the 30-minute prompt-cache TTL for GPT-5.6+ Responses models.
- Consolidate harness, office, session, sandbox, web-adapter, and shared-command ownership without changing the published root exports.

### Removed

- Remove managed skill packages and their Admin/package materialization surfaces. Workspace and conversation skills remain supported.
- Remove the auto-reply judge, command, configuration, and UI; explicit platform triggers remain supported.
- Remove the unused `/api/agent-events/stream` SSE mirror, its token setting, and supporting event types. The authenticated session viewer continues to use `/session/stream`.

### Fixed

- Preserve Pi's native optional tool schemas, require an explicit authorized execution environment for native file/shell tools, and keep container working directories inside the guest instead of applying them to the host Docker process.

## [1.0.0-beta.54]

### Changed

- Admin portal: MCP servers are added by pasting the server's standard `mcpServers` JSON (Claude Desktop / Cursor shape), stored as-is; the old name / target / `KEY=value` form is gone. Every add and preset install is followed by a real connection check, and the response shows the tool count or the server's own error; a per-server **Test** button re-checks an installed entry. Query-string values in listed URLs are redacted. stdio entries now run their command on the host at save time.

## [1.0.0-beta.53]

### Changed

- Graceful shutdown drains in-flight runs for up to five minutes (was 30 seconds) after stopping intake; runs still open at the deadline are aborted and their conversations receive a restart notice instead of silence. The pm2 template `kill_timeout` is now six minutes; update your `ecosystem.config.cjs` to match. Shutdown failures now log every nested step error.

### Added

- Send the run user (id and username) with Sentry events instead of stripping it, so Conversations show who sent each message; email and IP stay dropped.
- Set the Sentry conversation id to the session key on every agent run so Agent Monitoring groups gen_ai spans per thread.
- Report subagent outcomes to Sentry from the subagent tool: `agent.subagent.runs` / `agent.subagent.duration` metrics and a lifecycle breadcrumb for every status; a Sentry error under `error_domain=subagent` for `failed` and `invalid_output` (fingerprinted by error class) and for launch failures. `budget_exceeded`, `timeout`, `cancelled`, and `skipped` stay metrics-only. Reports carry run metrics, never task text or labels.

## [1.0.0-beta.52]

### Removed

- Remove the subagent `requiredTools` / `required_tools` mechanism: the post-run "every listed tool was invoked" check was a proxy for evidence that never held and failed only after the budget was spent. Callers that want evidence can read `toolCallCounts`.

## [1.0.0-beta.51]

### Fixed

- Drop `requiredTools` from built-in subagent profiles; requiring both `read` and `bash` discarded finished answers from tasks that needed only one of them.
- Keep a caller's `requiredTools` when the request also names a profile.
- Stop dropping the retained assistant message when an overflow retry rebuilds context from the store.

### Changed

- Read mikan session metadata through Pi's `session.getValue` in `open`/`inspect`; compare `fstat` fields instead of hashing the file for pending-session materialization.

## [1.0.0-beta.50]

### Fixed

- Tolerate byte-identical duplicate Dream session files while rejecting divergent same-ID files.

## [1.0.0-beta.49]

### Changed

- Configure OpenConnector only at startup with `OPENCONNECTOR_ENDPOINT` and `OPENCONNECTOR_ADMIN_TOKEN`; ignore settings overrides of the reserved server, and reduce the Admin MCP Marketplace to the Metabase preset.

## [1.0.0-beta.48]

### Added

- Add an offline session migration for Pi 0.84-generation v4 JSONL files, with verified atomic replacement and preserved `*.pi-084.bak` originals.

### Changed

- Upgrade `pi-agent-core` and `pi-ai` to 0.85.0 and persist sessions with the current `v: 4`, `storageVersion: 1` schema.
- Extend `mikan sessions migrate` to convert both legacy mikan v3 and Pi 0.84-generation v4 sessions while the daemon is stopped.

## [1.0.0-beta.47]

### Added

- Integrate OpenConnector as a host-side MCP gateway: Slack Conversation offices receive scoped runtime identities, while provider OAuth connections remain in the gateway and execution audit stays attributable to the originating conversation.
- Preserve operating guidance supplied during MCP initialization and present it to the agent with explicit system-prompt and user-intent boundaries.
- Add automatic selection of a sole OpenConnector provider connection when an action omits `connectionName`; retain explicit selection when multiple accounts exist.

### Changed

- Gate MCP tools by the platform trust model and enforce the untrusted package boundary.
- Make platform shutdown cleanup bounded and strengthen runner/session lifecycle rollback handling.

### Fixed

- Isolate Slack DM and thread E2E context and bound event-delivery waits.

### Tests

- Add coverage for OpenConnector token provisioning, MCP instruction propagation, connection selection, trust gating, lifecycle cleanup, and Slack isolation.

## [1.0.0-beta.46]

### Added

- Add an interactive `mikan onboard` wizard that configures one chat adapter, an LLM provider, and the sandbox, writing private environment and settings files while retaining non-interactive template generation.
- Derive shared workspace visibility from platform channel privacy: Slack public channels can update shared memory, private channels receive it read-only, and DMs, external channels, unknown kinds, and other platforms stay isolated unless explicitly overridden.
- Schedule Dream maintenance for Conversation-office memory with durable evidence checkpoints.
- Add an Admin MCP Marketplace with reviewed GitHub, Context7, Playwright, Sequential Thinking, and Metabase presets; Metabase installations accept an instance endpoint and API key.

### Changed

- Remove the executable extension system and its CLI/chat management surfaces; packages remain the supported path for deploying read-only skills.
- Remove the harness `auth.json` credential store; configure provider credentials through environment variables, onboarding, or the conversation vault.
- Remove Gondolin, Firecracker, and GitHub Cloud Build log integrations from the supported runtime surface.
- Fail closed when a sandbox backend cannot enforce an isolated office or read-only shared workspace memory; use `image:*` or explicitly select a trusted read-write projection.
- Consolidate runtime, session, adapter, web, and configuration ownership to reduce duplicate lifecycle and parsing rules.

### Fixed

- Preserve streamed UTF-8 output when host sandbox chunks split multi-byte characters.
- Re-aim migrated session lanes at the nearest surviving ancestor when the newest v3 entry contains facts but no v4 message.

### Tests

- Move CI action runtimes to Node 24 and strengthen runtime, presenter, workspace-projection, MCP marketplace, and session migration coverage.

## [1.0.0-beta.45]

### Fixed

- Session migration now collapses crash-duplicated v3 lines (a retried append writing the same header and entry twice) the way the v3 reader did, instead of failing v4 verification on the duplicate id. Found rehearsing the migration against 5,446 production session files; after the fix all migrate and reopen cleanly.

## [1.0.0-beta.44]

### Added

- Connect MCP (Model Context Protocol) servers via `mcpServers` settings and expose their tools to the agent as `mcp__<server>__<tool>`; stdio and streamable-HTTP transports, per-server failures isolated, credentials held host-side in server config out of the model's reach.
- Manage MCP servers from the admin portal: per-conversation and global panels with add, enable/disable, and remove; credential values are redacted to key names in the UI.
- Migrate sessions to pi's v4 format with a `mikan sessions migrate` CLI; pi upgraded to 0.84.3.
- Extensions can declare required host capabilities in `package.json` (`mikan.requires`); activation checks them before importing the module and `mikan ext validate` reports them.

### Changed

- Split the agent module into five authority modules (catalog, prompt, runner, subagent-runner, types); the runtime now owns session rotation decisions and per-event chat-history sync.
- Derive all platform command registration and routing from the single command manifest.
- Adopt pi-ai's retryable-error classifier instead of a local copy.
- Conversation runtimes are keyed by office key, fixing cross-conversation runner reuse after ID changes.

### Fixed

- Session files enforce single-writer ownership, surviving inode reuse and stale writer claims.
- Failed extension activations roll back cleanly; duplicate tool names are rejected.
- Slack slash commands in threads carry the thread session key instead of falling back to the top-level session.
- GitHub first-contact stop no longer creates participation state.
- Subagent deadlines are enforced by a single wall-clock timer; `before_agent_start` hooks run before auth and pre-turn compaction.
- Sandbox container removal failures no longer clear ownership, preventing orphaned containers.
- Run outcomes settle from the final message and run state is released on throw.

## [1.0.0-beta.43]

### Added

- Add an optional authenticated GitHub webhook endpoint that wakes polling immediately for lower-latency issue and pull-request handling.
- Add a machine-readable architecture index and generated system architecture documentation for repository-wide module boundaries and flows.

### Changed

- Run manual and automatic Session Dreams in the background while preserving session rotation and conversation maintenance boundaries.

### Fixed

- Wait for final Slack thread responses in isolation coverage instead of accepting provisional native-stream text.

### Tests

- Add regression coverage for GitHub webhook authentication and dispatch, background Session Dream lifecycle behavior, and final Slack stream settlement.

## [1.0.0-beta.42]

### Changed

[Showing lines 1-614 of 1985 (50.0KB limit). Use offset=615 to continue.]
