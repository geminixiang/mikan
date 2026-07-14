# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it leaves the 0.x line. While on `0.2.0-beta.*`, breaking changes may land in
any release.

## [Unreleased]

## [1.0.0-beta.15]

### Added

- Add native image generation with automatic upload through the active model provider.
- Add extension chat commands via `api.registerCommand`: deterministic `/name` dispatch with no model call; built-ins and first registrations win.
- Add an extension disposal lifecycle (`api.onDispose` or an `activate` return value), run when a harness instance is discarded (`/pi-new`, idle eviction, session rotation).
- Add `api.triggerRun(text)` to fire an immediate autonomous agent run, `api.uploadFile(path, title)` for proactive file uploads, and an explicit `conversationId` option on `api.notify` for cross-conversation posting.
- Add `agent_error` and `budget_exceeded` extension hooks so monitoring extensions see failed turns and tripped run budgets.
- Pass a `RunOrigin` (platform, triggering message id, user identity, attachments) to extension hook events, making `api.react` and per-user extension policy usable.
- Let `before_agent_start` extensions rewrite the user prompt or block the turn before the model runs; blocked turns leave no trace in the transcript or session store.
- Let `tool_result` extensions rewrite tool output (content and error flag) before the model and the session store see it, enabling secret redaction and output truncation.

### Changed

- Dispatch `before_agent_start` and `tool_result` hooks with chaining semantics (each handler sees earlier handlers' rewrites; any `block` wins) instead of first-result-wins.

### Fixed

- Dispose cached runners when models switch or environment credentials refresh.

### Tests

- Add coverage for image generation, extension lifecycle and hook rewrites, and runner disposal.

## [1.0.0-beta.14]

### Added

- Add GitHub inline review-thread intake and a `github_review_reply` tool.
- Add `github_sync`, `github_read`, and `github_issue` tools for repository refresh and issue or pull request operations.
- Add host-side Cloud Build log retrieval using GCP ADC or Workload Identity Federation.
- Add a minimal embedder example that runs without portal services.

### Changed

- Update eligible GitHub pull request head branches in place instead of opening duplicate pull requests.
- Drive platform command registration and routing from a shared command manifest.
- Use one cross-platform stop grammar, including `/stop` in GitHub conversations.
- Route sandbox file reads and writes through executors with staged, shell-safe transport.
- Keep sandbox settings nested through configuration resolution and updates.

### Fixed

- Preserve raw session keys when using Slack's Force Stop button.
- Spill large bash output into the runtime workspace so sandboxed agents can read it.
- Keep malformed event files visible in the admin portal for deletion.
- Unify platform formatting guidance across adapter and conversation contexts.

### Security

- Keep Cloud Build credentials host-side and outside agent sandboxes.
- Centralize runtime identity and sandbox path sanitization.

### Tests

- Add coverage for GitHub tool operations, review threads, Cloud Build logs, executor file transport, command manifests, runtime embedding, and session serialization.

## [1.0.0-beta.13]

### Added

- Add the `max` thinking level to commands, configuration, and the admin portal.
- Add quickstart and extension development guides across all supported locales.

### Changed

- Update pi agent dependencies to 0.80.6.
- Load platform-specific tool packs only for their configured adapters.
- Improve `github_checks` output and guidance for external CI providers.
- Synchronize configuration, platform, sandbox, session, skill, event, portal, and deployment documentation across locales.

### Fixed

- Fix broken CLI tables and dead documentation links across locales.

### Security

- Derive ambient shared-vault access from each platform's declared trust model and sandbox topology.

### Tests

- Add coverage for platform tool-pack isolation, external CI checks, and vault trust policy.

## [1.0.0-beta.12]

### Added

- Let `github_checks` fetch the log tail for a failing GitHub Actions job by job ID.

### Changed

- Require GitHub App Actions read permission for job log inspection.

### Fixed

- Treat skipped and neutral GitHub checks separately from failures in check summaries.

### Tests

- Add coverage for job log retrieval and check conclusion classification.
- Use collision-resistant temporary directories across parallel tests.

## [1.0.0-beta.11]

### Added

- Add a read-only `github_checks` tool for inspecting branch and pull request check runs.

### Changed

- Make `github_pr` idempotent so pushing an existing branch updates its open pull request.
- Teach the GitHub agent workflow to inspect CI, fix failures, and push updates.
- Require GitHub App Checks read permission for CI inspection.

### Tests

- Add coverage for GitHub check summaries and existing pull request updates.

## [1.0.0-beta.10]

### Fixed

- Retry cloning a GitHub repository on later triggers when the conversation clone is missing.

### Security

- Stop applying the ambient default shared vault to GitHub conversations while preserving explicit conversation vault grants.
- Document the platform, shared machine, and personal credential trust boundaries.

### Tests

- Add coverage for GitHub clone retries and platform-gated default vault resolution.

## [1.0.0-beta.9]

### Added

- Clone GitHub repositories into conversation workspaces and check out pull request heads.
- Add a `github_pr` tool that pushes agent changes from `pi/*` branches and opens pull requests.

### Changed

- Require GitHub App Contents read and write permission for repository automation.
- Post completed GitHub responses as single comments instead of streaming edits.

### Fixed

- Keep GitHub issue context inside the history recency window.

### Security

- Require commenters to have repository write permission or higher before triggering the agent.
- Keep installation tokens out of sandboxes and restrict agent pushes to non-force `pi/*` branches.

### Tests

- Add coverage for GitHub repository checkout, permission gating, pull request creation, and branch restrictions.

## [1.0.0-beta.8]

### Added

- Add a GitHub messaging adapter where each issue or pull request is an independent conversation.
- Add GitHub App authentication, mention and participation triggers, persisted polling cursors, and downtime replay.
- Add GitHub adapter deployment configuration and documentation.

### Tests

- Add coverage for GitHub polling, authentication, conversation context, triggers, and responses.

## [1.0.0-beta.7]

### Added

- Add TypeScript and npm-package extensions with `package.json` entrypoints and runtime dependencies.
- Add `mikan ext install`, `validate`, `list`, and `remove` commands.
- Add extension installation from Git sources and repository subpaths.

### Changed

- Treat reinstalling an extension as an update while preserving its data directory.
- Use `package.json` as the primary extension metadata source with `manifest.json` as a fallback.
- Convert the agent project manager example to TypeScript with a typed extension API.
- Add the Slack `reactions:write` scope and missing slash commands to the manifests and setup guides.

### Tests

- Add coverage for TypeScript loading, package metadata, extension CLI operations, and Git installation.

## [1.0.0-beta.6]

### Added

- Add emoji reactions for agents and extensions across Slack, Discord, and Telegram.

### Changed

- Default the agent project manager example to conversation-scoped extension data.
- Log when extensions rewrite the system prompt and report the resulting size change.

### Fixed

- Render Slack session links outside the triggered-by italic span.

### Tests

- Add coverage for the reaction tool and extension reaction API.

## [1.0.0-beta.5]

### Added

- Add `api.paths.sharedDataDir` for extension state intentionally shared across conversations.
- Add an idempotent, dry-run-first script for migrating extension code and data to the new layout.

### Changed

- Store conversation extension code and data under `conversations/<id>/` and global extension assets under `global/`.
- Make `api.paths.dataDir` conversation-scoped by default to prevent accidental cross-conversation state sharing.

### Tests

- Update extension loader and command coverage for the conversation-scoped layout.

## [1.0.0-beta.4]

### Changed

- Show an extension's slug in `/pi-extensions` when it differs from the manifest display name.

### Fixed

- Reject extensions installed directly at a scope root and show an actionable warning to use a named subdirectory.

### Tests

- Add coverage for scope-root extension mis-install detection and inventory warnings.

## [1.0.0-beta.3]

### Fixed

- Route `/pi-extensions` through Slack and include it in the bundled app manifests.

## [1.0.0-beta.2]

### Added

- Add `/pi-extensions` to list global and conversation extensions, manifest metadata, and bundled skills without activating modules.

### Tests

- Add coverage for extension inventory discovery and command output.

## [1.0.0-beta.1]

### Fixed

- Accept `maxOutputTokens` as an alias for `maxTokens` in custom model configuration.
- Restore npm release automation with compatible Node.js and npm versions.

### Tests

- Add coverage for production-shaped custom model configuration.

## [1.0.0-beta.0]

### Added

- Add mikan's native agent harness with model, authentication, session, compaction, and skill support.
- Add an extension system for hooks, schedules, notifications, data directories, secrets, and bundled skills, with an agent project manager example.
- Add per-conversation token usage bar charts to the admin portal.

### Changed

- Replace the pi-coding-agent runtime and session integration with the native harness built on pi-agent-core and pi-ai.

### Tests

- Add coverage for harness authentication, extensions, HTTP helpers, runner, sessions, and skills.

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
