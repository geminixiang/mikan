# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
from 1.0.0 on. The package interface is the root export of `@geminixiang/mikan`; the
CLI, `settings.json`, `mikan.env`, and the state layout under `~/.mikan` are covered too.
The GitHub adapter is experimental and excluded: its settings and conversation layout may
change in a minor release.

## [Unreleased]

### Changed

- A DM task survives a restart. A deploy no longer waits up to five minutes for running
  tasks, and a task interrupted by a deploy or crash in the last 24 hours resumes in its
  thread with a notice. A stopped task stays stopped.
- A finished task's answer is written to the DM conversation that started it, so a later
  question in the DM can be answered from the result.

### Fixed

- A task run is no longer offered `task_status` and `start_task`, which made one of three
  test tasks report its own status instead of doing the work.

## [1.0.2] - 2026-10-08

### Changed

- The system prompt lists the folders already in the office's `scratch/` and asks the agent
  to reuse an existing clone, with `git fetch` or `git worktree add`, before cloning again.
  A new thread previously could not tell a repository was already there and cloned another copy.

### Fixed

- A command left running in a container sandbox by a crashed or killed daemon is ended
  when the daemon starts again, so a resumed or repeated run does not race the old copy.

## [1.0.1] - 2026-10-07

### Changed

- `mikan onboard` asks for a sandbox image instead of a sandbox mode: the published
  `mikan-sandbox` image (recommended), `debian:trixie-slim`, or any other image. It writes
  `~/.mikan/ecosystem.config.cjs` with that image and prints the `docker pull` and
  `pm2 start` commands, so the PM2 file no longer has to be downloaded. An existing
  ecosystem file is kept. `host` and `container:<name>` still work through `--sandbox` but
  are no longer offered.
- The README and the quick start and deployment guides, in all four languages, follow the
  onboard flow: install, `mikan onboard`, `docker pull`, and `pm2 start` with the generated
  ecosystem file. The docs site has a new logo, favicon, hero image, and footer.

### Fixed

- Stopping a run, or a command timing out, now ends the command inside the container
  sandbox. Before, only the host `docker exec` client was killed and the command kept
  running in the container. Images without `setsid` keep the old behavior.

## [1.0.0] - 2026-10-06

1.0.0 is the first stable release. It replaces the 0.5.3 runtime, which ran on
`pi-coding-agent`, with mikan's own harness on `pi-durable` and `pi-ai`, and gives every
conversation its own office. The 97 `1.0.0-beta.*` prereleases are summarized here; their
individual notes remain in the [GitHub releases](https://github.com/geminixiang/mikan/releases).

### Upgrading from 0.5.3

`mikan migrate` upgrades a 0.5.3 install in place; it is the only supported upgrade path, and
formats that existed only in 1.0.0 prereleases are not converted. The daemon refuses to start
while migrations are pending and prints the exact command to run. Follow
[Upgrading from 0.5.3](https://mikan.geminixiang.com/deployment/#upgrading-from-053) in the
deployment guide, which lists what migrates, what does not, and what to check afterwards.

### Added

- **Conversation offices.** Each conversation gets its own directory, sandbox runtime, vault,
  settings, sessions, and scheduled events, named by an office key
  (`v1-<platform>-<readable-id>-<hash>`) so two platforms never collide on one raw id. Offices
  are public or private, following the Slack conversation type, and `image:*` sandboxes enforce
  it: a private office sees only itself plus shared knowledge. `mikan office list` prints them.
- **GitHub adapter (experimental).** A regular GitHub account, bound with a fine-grained token and an
  organization webhook, answers mentions, assignments, and review requests; each issue or pull
  request is one conversation. Its settings and conversation layout may change in a minor
  release, and conversations from this version may not carry over.
- **Durable sessions.** Each office keeps its sessions in one SQLite database (`sessions.db`)
  through `pi-durable`. Sessions survive restarts, a channel's top-level session stays current
  until `/new` with Pi compacting old context, and threads keep their own sessions. The agent's
  `history` tool reads the conversation's earlier sessions.
- **MCP servers and codemode.** `mcpServers` in `settings.json` connects MCP servers; the agent
  reaches their tools through Pi's codemode and searches large tool lists on demand.
  OpenConnector can provision a per-conversation MCP token.
- **Subagents.** The agent delegates bounded work, in parallel or as a dependency graph, to
  subagents with role profiles, their own tools, and token, cost, and time budgets.
- **Admin portal and session viewer.** `/admin` opens a 30-minute portal for model, sandbox
  limits, office visibility, reply mode, MCP servers, and skills; `session` opens a read-only view
  of the current session.
- **Memory capture.** After each human-triggered run, durable facts go to the office's
  `MEMORY.md`.
- **Jev.** A small model answers yes/no decisions, such as whether a Slack message addresses the
  bot in `/pi-auto-reply jev` mode, and drives the `jev_browser` tool.
- **Platform rendering.** Slack answers stream into native markdown and table blocks, with the
  `slack_blockkit` tool for interactive messages; Discord uses Components V2; Telegram uses rich
  formatting. Long answers continue in the thread instead of failing.
- **CLI.** `mikan onboard` writes `settings.json` and `mikan.env` from a few questions, `mikan env`
  lists every environment variable and which are set, and `mikan migrate` applies state
  migrations with `--dry-run`.
- **Observability.** Standard OTLP export through the `OTEL_*` variables, alongside Sentry.

### Changed

- Node.js 24.15.0 or newer is required.
- `mikan.env` holds secrets and deployment addresses; `settings.json` holds behavior. The
  Sentry DSN is read only from `SENTRY_DSN`, so a `sentry.dsn` setting is ignored, and the GitHub
  adapter's repositories and trigger rules live under `github` in `settings.json`. At startup the
  daemon logs each environment variable it no longer reads, with what replaces it.
- State lives in `~/.mikan` only: `settings.json`, `mikan.env`, `models.json`, vaults, and the
  host-only per-conversation directories under `conversations/`. Per-conversation settings,
  sessions, and scheduled events moved out of the workspace, where sandboxes could read them.
- The workspace argument is optional and defaults to `~/.mikan/workspace`.
- Inside a sandbox, an office's files are at `/workspace/<office-key>` instead of
  `/workspace/<conversation-id>`. Paths quoted in sessions from before the upgrade point at the
  old location.
- `image:<image>` provisions one managed container and one vault per office, recreated from the
  current image when missing; `/pi-sandbox boost` raises its limits until it stops.
- Vault directories use hashed keys instead of raw user and container names.
- Only `session` and `stop` work without a leading slash; `new`, `model`, and `auto-reply` need
  their slash forms (`/new`, `/pi-new`, …).
- Auto-reply is Slack-only and takes `on`, `off`, or `jev`. A 0.5.3 channel with auto-reply
  rules replies to every top-level message; the rules are ignored.
- The link server for the portal and credential links listens on `127.0.0.1` unless
  configured otherwise.
- The package exports only what an embedder needs: `createConversationRuntime`,
  `createWorkspace`, `createOfficeAddress`, `officeKey`, `createConversationEvent`,
  `createConversationMessage`, `defaultCommandHandlers`, `MikanModels`, and the types they use.
  The `@geminixiang/mikan/harness` and `@geminixiang/mikan/sandbox` entry points are gone.

### Removed

- The `pi-coding-agent` runtime and its extension loading; mikan loads no third-party code into
  its process (ADR 0006). Skills in `skills/` directories remain.
- The `firecracker:*` and `cloudflare:*` sandboxes.
- `--state-dir` and the `STATE_DIR` / `MIKAN_STATE_DIR` variables, and `--download`.
- Auto-reply on Discord and Telegram, and auto-reply rules.
- `SENTRY_ENABLED` (leave `SENTRY_DSN` unset to turn Sentry off) and `HTTP_IDLE_TIMEOUT`
  (outbound HTTP streams time out after five minutes).
- Provider keys in `~/.pi/mikan/auth.json`; put them in `~/.mikan/mikan.env` or `models.json`.

### Fixed

- Slack startup and reconnects no longer hang without a log line when Slack accepts the
  connection and never answers; a socket silent for 30 seconds is dropped and retried, and the
  daemon logs `Slack connection lost; reconnecting` and `Slack reconnected after Ns`.
- Stopping the daemon while it is still connecting to Slack ends in a graceful shutdown.
- When Telegram ends long polling because the token was revoked (401) or another process polls
  the same bot (409), the daemon logs the reason and exits with code 1 for the process manager
  to restart, instead of running on without receiving messages.
- A Slack message whose acknowledgement was lost during a reconnect runs once, not twice.

## [0.5.3] - 2026-06-30

### Added

- Append a session-view link to event-triggered attribution messages.
- Show raw cached token counts and cache-hit rate in usage summaries.

### Changed

- Use a stable, low-noise usage summary layout with token units and fixed cost breakdowns.
- Mark the auto-reply command as deprecated.

### Fixed

- Harden state file writes to avoid readers seeing partial state.
- Reject malformed OAuth configuration during login setup.

### Tests

- Add unit coverage for utility and tool modules.
- Expand Slack end-to-end coverage and make CI Slack artifacts more reliable.

## [0.5.2] - 2026-06-26

### Added

- Show the top 20 pi sessions by token usage in the admin portal, including channel labels and raw input, output, cache read, cache write, total, and cost columns.

## [0.5.1] - 2026-06-26

### Added

- Render markdown as Slack Block Kit.
- Show live tool progress during agent runs.

## [0.5.0] - 2026-06-25

### Added

- Add the Starlight documentation site with localized docs for English, Japanese, Simplified Chinese, and Traditional Chinese.
- Add platform adapter guides for Slack, Discord, and Telegram.
- Add a web agent-events portal for streaming agent events.

### Changed

- Align adapter, runtime, and session naming around conversation terminology for clearer contributor navigation.
- Update project dependencies and bundled pi packages.

### Fixed

- Preserve custom Starlight theme component overrides.
- Keep the docs dev server from restarting when settings cleanup runs.
- Tighten Sentry event sanitization.

## [0.4.8] - 2026-06-22

### Changed

- Update bundled pi packages to the 0.79.9 line.

## [0.4.7] - 2026-06-22

### Fixed

- Apply the recent-days and max-messages history window when syncing existing chat sessions so resuming a session no longer replays unbounded older log history.

### Changed

- Always report a usage summary whenever token usage is available.

### Tests

- Add coverage for capping existing chat history sync to the recent history window.

## [0.4.6] - 2026-06-18

### Fixed

- Store Slack streamed responses as a single finalized bot log entry instead of per-delta fragments.
- Coalesce legacy Slack bot log fragments when bootstrapping chat sessions so platform history is not filled with partial words.

### Tests

- Add coverage for coalescing streamed bot history and logging only finalized Slack responses.

## [0.4.5] - 2026-06-17

### Added

- Rotate shared top-level channel sessions on biweekly Sunday boundaries while keeping thread sessions fixed.

### Changed

- Bootstrap rotated shared channel sessions from the recent two-week chat log window and prevent older log history from being resynced into the active session.
- Harden managed Docker sandboxes with dropped capabilities, no-new-privileges, and a PID limit.

### Fixed

- Report usage summaries when token usage is available even if provider pricing data is missing.

### Tests

- Add coverage for session rotation, thread bootstrap watermarks, sandbox hardening flags, and usage summaries without cost data.

## [0.4.4] - 2026-06-12

### Fixed

- Require exact provider model ID matches when grouping verified admin model availability.

## [0.4.3] - 2026-06-12

### Added

- Group admin model selectors by verified availability for OpenAI and Anthropic keys.
- Log the active provider and model when each agent run starts to simplify server-side debugging.

## [0.4.2] - 2026-06-11

### Fixed

- Resolve custom providers through pi's model registry so conversation settings can select models from `models.json`.
- Resolve attached file paths from the sandbox runtime workspace so image sandboxes upload generated files from the correct host path.

## [0.4.1] - 2026-06-08

### Changed

- Update bundled pi packages to the 0.78.1 line.

### Fixed

- Stream Slack responses with delta-only appends to avoid duplicated message segments and streaming state conflicts.
- Include Slack streaming recipient metadata so threaded streamed replies work in Slack E2E and production workspaces.

### Tests

- Add Slack streaming E2E coverage for delta appends without duplicate text.

## [0.4.0] - 2026-06-07

### Added

- Add streamed response deltas across adapters so replies can update progressively.
- Add Slack reply mode configuration in the admin portal.
- Add event tool CRUD support for listing, reading, updating, and deleting scheduled events, with conversation-scoped listing by default and explicit all-event listing.

### Changed

- Reorganize source modules and centralize shared type definitions for clearer contributor navigation.
- Centralize adapter conversation intake and reduce wrapper indirection across runtime, adapters, commands, config, and web modules.
- Attribute agent Sentry traces with platform and conversation context for clearer operator debugging.

### Fixed

- Persist global settings overrides correctly.
- Warn when invalid custom OAuth service definitions are skipped instead of silently dropping them.

## [0.4.0-beta.0]

### Added

- Add streamed response deltas across adapters so replies can update progressively.
- Add Slack reply mode configuration in the admin portal.
- Add event tool CRUD support for listing, reading, updating, and deleting scheduled events, with conversation-scoped listing by default and explicit all-event listing.

### Changed

- Reorganize source modules and centralize shared type definitions for clearer contributor navigation.
- Centralize adapter conversation intake and reduce wrapper indirection across runtime, adapters, commands, config, and web modules.

### Fixed

- Persist global settings overrides correctly.

## [0.3.2] - 2026-06-02

### Fixed

- Preserve trigger attribution in streamed agent responses so tool-written GitHub comments include the triggering user.

## [0.3.1] - 2026-06-02

### Added

- Add Slack Block Kit response support and document Block Kit implementation lessons.

### Fixed

- Require explicit mentions before Slack thread replies trigger the bot.

### Tests

- Enforce phase-one strict checks and unused export checks.

## [0.3.0] - 2026-06-01

### Added

- Add source directory README guides for contributors navigating adapters, commands, runtime, sessions, sandbox, tools, login, admin, and session-view code.

### Changed

- Centralize chat session bootstrapping through `ChatSessionManager` so Slack top-level and thread sessions share the same log-based history sync path.
- Rename Slack branch/fork terminology to thread/anchor terminology across the adapter, session viewer, and documentation.
- Model session-view related sessions as parent/thread relationships, including fixed-path thread sessions without legacy parent metadata.
- Remove legacy thread fork and snapshot helpers from session storage.

### Fixed

- Anchor session-view thread links on the root turn instead of earlier bootstrapped context messages.

## [0.3.0-beta.0]

### Changed

- Centralize chat session bootstrapping through `ChatSessionManager` so Slack top-level and thread sessions share the same log-based history sync path.
- Rename Slack branch/fork terminology to thread/anchor terminology across the adapter, session viewer, and documentation.
- Model session-view related sessions as parent/thread relationships, including fixed-path thread sessions without legacy parent metadata.
- Remove legacy thread fork and snapshot helpers from session storage.

### Fixed

- Anchor session-view thread links on the root turn instead of earlier bootstrapped context messages.

## [0.2.4] - 2026-06-01

### Fixed

- Make Slack bot-rooted thread session seeds loadable by storing platform-history assistant metadata.

## [0.2.3] - 2026-06-01

### Added

- Add a sandbox resource limit tool for checking and temporarily updating managed sandbox CPU and memory limits.

### Fixed

- Isolate Slack sessions rooted at bot messages so thread replies do not inherit unrelated channel history.

## [0.2.2] - 2026-05-30

### Added

- Add `/admin` portal with token-protected access via `/admin` and `/pi-admin` commands.
- Add admin APIs and UI for conversation settings, global settings, workspace preview, skills, events, session links, and login/vault links.
- Add model selection in the admin portal using `ModelRegistry.getAvailable()` instead of free-text fields.
- Share portal shell chrome across admin, session-view, and login/vault pages.
- Document admin, login, and session token boundaries in `docs/portal-auth-model.md`.

### Changed

- Normalize slash-command feedback into muted compact summaries.
- Align desktop layout widths across all portal surfaces.

## [0.2.1] - 2026-05-27

### Added

- Add expanded command, configuration, deployment, development, session, and skill documentation.
- Add README hero and architecture diagrams.
- Add project agent development rules and Karpathy coding guidelines.

### Changed

- Simplify the README overview and clarify sandbox runtime architecture documentation.
- Simplify file guards and retry helpers.

### Fixed

- Retry attachment downloads.
- Skip retry sleep on the final attempt and clarify retry naming.

## [0.2.0] - 2026-05-23

### Changed

- Renamed the project, CLI, npm package, GitHub repository, documentation, release skill, and sandbox image references to mikan.
- Changed platform credentials to unprefixed env vars (`SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`) while keeping `MIKAN_*` aliases as fallbacks.
- Changed runtime env vars such as `LINK_URL`, `LINK_PORT`, `STATE_DIR`, OAuth scope overrides, and Cloudflare sandbox settings to prefer unprefixed names with `MIKAN_*` fallbacks.
- Raised the minimum supported Node.js version to `>=22.19.0`.
- Updated internal variable, function, type, Docker label, sandbox image, and generated resource names to use mikan naming.
- Added manual dispatch support to the CI workflow.

## [0.2.0-beta.25] - 2026-05-23

### Changed

- Grouped session modules under a single directory.
- Centralized command parsing across adapters.
- Removed explicit `any` usage across the type surface.
- Cleaned unused dependencies.

### Tests

- CI now enforces coverage thresholds.

## [0.2.0-beta.24]

### Fixed

- Session history writes now emit valid assistant messages.

## [0.2.0-beta.23]

### Fixed

- Refresh stale channel history before forking a thread.
- Separate history seeds from live sessions to prevent cross-contamination.
- Materialize channel history when the first thread is created.

### Added

- Scripts to migrate session history and repair orphan thread sessions.

## [0.2.0-beta.22]

### Fixed

- Slack: fork bot response threads from the channel session so replies inherit context.
- Vault: preserve failures when the default shared vault cannot be applied.

## [0.2.0-beta.21]

### Added

- Vault: seed new sandboxes from a shared profile (`sandbox.defaultSharedVault`).

## [0.2.0-beta.20]

### Added

- Sentry: report user-facing failures.
- Auto-reply: surface configured rules in the status command.

### Fixed

- Slack: anchor event-fork sessions correctly (#61).
- Slack: keep session ephemerals scoped to threads.
- Agent: require history search before answering unknown replies.
- Agent: keep quiet tool errors out of chat.

### Changed

- Removed cloud-logging config — log to stdout/stderr and route via your process manager.

## [0.2.0-beta.19]

### Fixed

- Sandbox: bootstrap `gh` git credentials inside managed containers.

## [0.2.0-beta.18]

### Fixed

- Sandbox: update memory swap when applying CPU/memory limits.
- Slack: preserve long replies posted in threads.

## [0.2.0-beta.17]

### Added

- Sentry: store env values and write a `sentry-cli` config for richer error reports.

### Changed

- Bumped `@earendil-works/pi-*` packages.

## [0.2.0-beta.16]

### Performance

- Slack: unblock startup while backfill is running.

## [0.2.0-beta.15]

### Added

- Config: validate JSON files with TypeBox schemas.
- Agent: attribute the trigger (mention/direct/auto-reply/…) in responses.

## [0.2.0-beta.14]

### Fixed

- Login: refresh the sandbox after copying a shared profile.

### Changed

- Simplified command dispatch, token stores, and re-exports (#60).

## [0.2.0-beta.13]

### Added

- Login: gcloud OAuth support.

## [0.2.0-beta.12]

### Fixed

- Auto-reply: persist the resolved session key.

## [0.2.0-beta.11]

### Fixed

- Login: make Slack login ephemeral and refresh vault mounts after credentials change.

### Changed

- Sandbox: update base image and tags.

## [0.2.0-beta.10]

### Added

- Auto-reply: channel trigger rules and a configurable judge model (`llm.autoReply`).
- Slack: native E2E smoke workflow under `e2e/`.

### Fixed

- Auto-reply: use mom-compatible marker files; judge policy never throws and always logs.
- Events: validate one-shot times before scheduling; simplify fresh follow-up sessions.

### Changed

- Onboard: default model is `claude-sonnet-4-6`.
- Separated runtime and control-plane paths.

## [0.2.0-beta.9]

### Added

- Session view: floating composer and per-message copy button.
- Docker sandbox: add `rg` and `fd` to the image.

### Fixed

- Session view: ignore Enter during IME composition; preserve code-block contrast.

## [0.2.0-beta.8]

### Added

- Login: shared vault profiles.
- Session view: improved interactive chat console.
- Slack: harden socket connection and label the platform in the connect log.
- Agent: `ThinkingLevel` type on session parameters.

### Changed

- Sandbox: store the image workspace mount in settings.
- Dropped `vault.json` metadata — directories are the only source of truth.
- Refactored agent runner orchestration into smaller modules.

### Removed

- `UserBindingStore` and `bindings.json` plumbing.
- Log-to-session backfill.

## [0.2.0-beta.7]

### Added

- Sandbox: temporary `boost` command for one-off CPU/memory bumps.
- Slack: mute command summaries.

### Changed

- Migrated `pi-*` packages to the `@earendil-works/` namespace.

### Fixed

- Slack: log messages from external apps; hide bash tool diagnostics.
- Session: ignore history written before a reset.
- Agent: clarify runtime workspace paths in the system prompt.

## [0.2.0-beta.6]

### Added

- Commands: conversation model switch (`/pi-model …`) with `:thinking` shorthand.
- Config: onboarding flow for global settings (`mikan --onboard`).
- Docs: PM2 ecosystem config and production deploy guide.

### Changed

- Config: nest settings schema; align chat platform commands.

### Fixed

- Slack: strip only the bot's own mention from message text.

## [0.2.0-beta.5]

### Added

- Sandbox: Cloudflare sandbox bridge (experimental).
- Tests: unit coverage for `CommandRegistry` and command handlers.

### Changed

- Env: renamed `MOM_*` env vars to `MIKAN_*` (breaking).
- Vault: conversation vault directories are now the source of truth; dropped platform prefix from the conversation vault key.
- Config: `--state-dir` is the single source for settings.
- Tightened command/runtime types and added a `postPrivate` capability.

## [0.2.0-beta.4]

### Changed

- Hardened core writes; unified adapter retry and log helpers.
- Eliminated duplication across adapters, vault, and Slack command factories (#53).
- Session forks now anchor to raw split points.
- Adapter-specific stop logic stays in adapters.

### Fixed

- Slack: tighten thread reply triggers.

## [0.2.0-beta.3]

### Added

- Session view: Slack-aware session viewer with branching (#51).
- Login: built-in credential presets and a redesigned credential portal.
- Sandbox: image-mode container CPU/memory limits (#50), bridge network isolation, `ffmpeg` in the tools image.

### Fixed

- Discord: normalize thread sessions; queue follow-up messages; persistent channel sessions; hide usage summary by default.
- Events: restore Slack synthetic notifications (#52).
- Attachments: wait for downloads before the agent accesses them.

## [0.2.0-beta.2]

### Added

- Per-user vault system for actor-scoped credential isolation (#24).
- Managed image sandbox (`--sandbox=image:<image>`) (#47).
- Login flow wired into the runtime; credential onboarding server (#32, #34).
- Slack: `/pi-new` and `/pi-login` DM commands.
- Events: actor-aware scheduling tool (#36, #39).

### Changed

- Internal contracts unified around "conversation" naming across adapter, store, config, log, and UI layers (#38, #41, #42, #43, #44, #46).

### Fixed

- Telegram: handle bare `stop` in shared chats; escape unsupported HTML entities.
- Slack: queue follow-up messages per session.

## [0.2.0-beta.1]

### Added

- File-backed credential vault (#31) and per-user vault routing (#33).
- OAuth: GitHub redirect flow, scope parity with `gh` CLI, gcloud OAuth.
- Sandbox: separate `stateDir` from `workspaceDir` to keep secrets out of sandboxes.

### Security

- Hardened vault writes, file permissions, and login flow.
- Stopped leaking secrets in `docker exec` args.
- Enforced vault sandbox isolation policy.

### Changed

- Renamed `docker` sandbox mode to `container` (breaking).
- Replaced `DockerProvisioner` with `DockerContainerManager` + idle stop.

## [0.2.0-beta.0]

### Added

- Sentry integration for error monitoring, tracing, and metrics (#21).
- Persistent session management with in-thread replies (#18).
- Telegram: native slash commands; private-chat session fix (#15).
- `pi-coding-agent` extension loading (#12).

## Earlier releases

For releases prior to `0.2.0-beta.0` (i.e. the `0.1.x` line), see the [git tag history](https://github.com/geminixiang/mikan/tags).
