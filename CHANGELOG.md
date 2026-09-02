# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it leaves the 0.x line. While on `0.2.0-beta.*`, breaking changes may land in
any release.

## [Unreleased]

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

- Dispatch Slack extension commands when users type the command name without a leading slash, so documented Agent Project Manager commands work in ordinary messages.
- Update `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` to 0.83.0.
- Clarify Agent Project Manager onboarding, initial behavior, and the distinction between commands and natural-language tasks across all translated guides.

### Fixed

- Stabilize Slack end-to-end coverage for extension command dispatch, Agent Project Manager, and long-message threads.

### Tests

- Add regression coverage for slashless extension command routing and conversation runtime dispatch.

## [1.0.0-beta.41]

### Added

- Add Slack App and Agent manifests plus support for `assistant_view` and `agent_view` lifecycle events, including thread-aware assistant context and optional socket-event tracing.
- Add Discord Components V2 responses with native sections, separators, containers, and markdown-table rendering suited to Discord's width model.
- Add rich Telegram responses through platform-native formatting.
- Show the current activity of running subagents in progress dashboards.
- Add an end-user Agent Project Manager guide in English, Japanese, Simplified Chinese, and Traditional Chinese.

### Changed

- Pace progressive redraws by elapsed time instead of response volume, and edit overflow messages rather than repeatedly posting replacements.
- Split Slack streamed text at the 12,000-character API limit, decline unsupported native streams before starting them, and hand off a truncated final tail exactly once.
- Report package-installed extensions in `/extensions` and return a clear compatibility error when an extension requires a newer mikan version.

### Fixed

- Preserve final-source preparation during progressive replacement and cut truncated Slack messages at line boundaries.
- Distinguish Slack length-limit failures from other send errors instead of treating every failure as oversized content.
- Prevent desktop automation helpers from sending into a Slack thread's main composer.

### Tests

- Add coverage for Slack assistant lifecycle and stream limits, Discord Components V2 and table formatting, progressive overflow editing, rich Telegram context, subagent activity reporting, and extension compatibility reporting.

## [1.0.0-beta.40]

### Added

- Add deterministic extension callback schedules that run host-side without an agent run, model call, or token spend; schedules persist across restarts and use host-authoritative storage.
- Add extension APIs for reading conversation or thread history, listing active platform users, opening direct-message conversations, and posting threaded notifications.
- Add declarative extension secrets with activation-time validation, CLI visibility, admin portal provisioning, and purge support.
- Add a production-ready agent project manager example built as an Event → Workflow → Task pipeline with SQLite persistence, scheduled heartbeats, threaded polling, delivery tracking, and Slack end-to-end coverage.

### Changed

- Make proactive extension messaging default to the conversation's platform, removing ambiguity in multi-platform deployments.
- Make `api.notify` return the posted message ID and allow `api.fetchHistory` to read replies beneath that message, enabling poll-only follow-up workflows without webhooks.
- Make `mikan ext remove --purge` sweep an extension's schedules, secrets, data directories, and optional workspace event files while reporting leftovers for non-purge removals.
- Enable stricter TypeScript and lint enforcement for indexed access, type-only imports, Node.js import protocols, dependency cycles, explicit `any`, nesting depth, function size, and parameter count.
- Consolidate duplicated authorities and thin wrappers into their owning modules, and refresh repository documentation for the office architecture.

### Tests

- Add coverage for callback schedule persistence and dispatch, extension secrets, platform reads, threaded notifications, purge behavior, and the agent project manager pipeline.

## [1.0.0-beta.39]

### Fixed

- Slack mentions now actually notify people: the adapter resolves response-source `<@userName>` (and display-name) mentions to Slack's native `<@U…>` id form on every outgoing path, including streamed responses. Previously mentions rendered as literal text and never pinged anyone; scheduled-event texts that hard-require raw user ids as a workaround can go back to plain `<@userName>`. The system prompt now also names the Users table as the one source of mention handles and forbids borrowing handles from other platforms (a GitHub username is not a Slack mention).
- Discord slash commands register again: the `/sandbox` option description had grown past Discord's 100-character limit, which made Discord reject the whole registration batch at startup. A manifest test now enforces the budget for every command, argument, and Telegram menu description.
- Fix `generate_image` losing its generated file at the upload step (`sh: … cannot open /workspace/<file>: No such file`): the tool wrote the image host-side into the workspace base and then handed a bare filename to the attach upload path, which reads through the sandbox — where the base is no longer mounted since the office layout migration. The image is now written into the conversation's own office directory (guest-visible) and uploaded directly by host path, with no sandbox round-trip, under every door policy. Image-generation provider errors now also name the model id that was sent.
- The Slack e2e workflow works again after the door-policy and office-key changes: the runner's settings opt into the trusted door policy explicitly (host mode is refused under the isolated default by design), local-delivery verification reads the office-key log path, and one recall prompt was disambiguated.

### Changed

- The Conversation office is now a first-class module: `src/office/` owns identity, the Workspace/Office layout values, the registry journal, and the boot migration. Option bags across the runtime carry one `office` value instead of parallel address/directory fields, the attachment convention has a single owner on the shared adapter surface, and `ChannelStore` is gone. No behavior or on-disk layout change.
- Embedders can now construct the runtime from the public surface: `createWorkspace`, `createOfficeAddress`, and `officeKey` (plus the `Office`/`Workspace` types) are exported, and `createConversationRuntime` takes a `workspace` value in place of the `workingDir` string.
- Repository layout for contributors: run-it assets live under `deploy/` (pm2, docker, examples), the test suite lives at `src/test/`, and tool configs live in `.config/` (root keeps `package.json` and `tsconfig.json`). The build config moved to `src/tsconfig.build.json`.

## [1.0.0-beta.38]

### Fixed

- Align the conversation-skill symlink guard with what the host actually reads: symlinked entries are skipped per skill — with the skipped paths named in the host log and surfaced to the agent in its prompt — instead of one symlink anywhere disqualifying the whole tree, and symlinks inside vendored `node_modules` or dot directories (which the loader never reads) no longer disqualify anything. Offices whose skills vanished because a skill vendored npm dependencies (`.bin` symlinks) get them back.

## [1.0.0-beta.37]

### Fixed

- Stop discarding preserved container contents on mount drift: a drifted managed container is now committed and re-created from its snapshot with the desired mounts — writable layer intact — instead of being rebuilt from the base image. This closes the gap that recreated layout-migrated containers from scratch on their first message after upgrade (stored mount signatures went stale as shared sources changed overnight). `MIKAN_SKIP_CONTAINER_PRESERVATION=1` restores plain recreation.
- Stop treating ordinary directory activity as mount drift: directory mount sources are now fingerprinted by identity (a replacement directory is drift) instead of size and mtime, so event-file churn and children being created no longer force container rebuilds. File sources keep content fingerprints — atomic replacement leaves a stale inode in the container and must recreate it.
- Door-policy changes now preserve container contents through the rebuild; the portal and `/pi-sandbox door` copy no longer warn about a reset.

## [1.0.0-beta.36]

### Added

- Make the office door policy configurable: the Admin portal gains a per-office selector (global default / isolated / trusted shared-support / trusted full) plus a global-default selector, and the existing `/pi-sandbox` command gains `door <default|isolated|shared|full>` — both write the explicit `sandbox.workspace` settings and retire the legacy `image.workspaceMount` key on save.
- Door-policy changes follow the same clear-or-refuse contract as model changes (the system prompt bakes the workspace projection), and the sandbox container is rebuilt with the new mounts on the office's next message.

## [1.0.0-beta.35]

Completes the office storage migration introduced in 1.0.0-beta.34: sandbox containers now survive it with everything installed inside them intact. Upgrading directly from 1.0.0-beta.33 or earlier to this release keeps container contents; deployments that already booted 1.0.0-beta.34 had their containers recreated by that release.

### Added

- Preserve managed sandbox containers through the office layout migration: each container still mounting legacy paths is committed to a snapshot and re-created with translated workspace, state, and vault mounts, keeping its writable layer — software installed inside survives the upgrade.
- Migrate containers off the boot path: on demand before a conversation's next message and via a background sweep after the platforms start, so boot stays fast and nothing blocks on the one-time cost.
- Resume interrupted container migrations safely: the pre-removal mounts ride on the snapshot image, a crash at any point resumes without data loss, and snapshots are reclaimed once a container naturally returns to the base image.
- Add the `MIKAN_SKIP_CONTAINER_PRESERVATION` escape hatch to fall back to plain container removal.

### Tests

- Cover translate, no-op, resume, orphan-resume, snapshot reclamation, and disarmed paths on a stateful docker mock, plus bind-translator unit tests; rehearsed against real docker including the crash-resume path.

## [1.0.0-beta.34]

**One-way storage migration.** On first boot this release renames every conversation's workspace directory, credential vault, and host state tree to platform-scoped office keys, journaled with crash recovery. Back up the state dir and workspace before upgrading; earlier versions cannot read the migrated layout, so there is no downgrade. Managed sandbox containers for migrated conversations are recreated, which resets software installed inside them once (a preservation path is planned for a follow-up release).

### Added

- Isolate every conversation as an office keyed by platform and conversation id, ending all cross-platform collisions on shared raw ids: runtime state, workspace files, chat logs, attachments, credential vaults, settings, extension data, and scheduled-event scoping are now platform-scoped.
- Migrate legacy directories automatically at boot: ownership is verified against each enabled platform's id format, ambiguous or unrecognized directories fail closed as needs-owner, and repositories or build output sitting in a trusted workspace root are skipped in place.
- Add the `mikan office` CLI: `list` shows the office inventory and pending migrations; `claim` assigns an owner platform to a legacy directory the format check cannot decide.
- Record every office in a host-only registry at creation, giving Admin and CLI surfaces a durable raw-id ↔ office mapping.

### Changed

- Scope the Admin portal by office: conversation lists show platforms, cross-platform targets name theirs explicitly, and all paths, settings, projections, and vault links resolve from the full office address.
- Show office-key paths (`/workspace/v1-slack-…`) in agent prompts and workspace listings; transcripts from before the upgrade may reference old paths until the agent re-lists.
- Breaking for embedders: `createRunner`, `MessagingEventHandler`, settings, package, and extension APIs now carry an `OfficeAddress`.

### Fixed

- Preserve Session Dream memory writes after the migration; the write grant previously derived the memory path from the raw conversation id and would have refused every dream.
- Stop `mikan ext` from resolving conversation state against the wrong state dir when `--state-dir` differs from the environment default.
- Keep thread sessions anchored to their main-session lineage via `parentSessionId`.

### Tests

- Add migration-engine coverage for claiming, crash recovery, ambiguity, reappeared directories, vault and state-tree moves, and format verification; rehearsed end-to-end against a production-shaped 327-entry workspace (285 offices migrated in ~2.4s, zero manual claims, checksums identical).
- Keep state-writing tests out of the developer's real `~/.mikan` with a suite-wide temporary state dir.

## [1.0.0-beta.33]

### Changed

- Give every built-in subagent profile a 100,000-token allowance and honor larger token budgets requested by the parent model.

### Fixed

- Disable Sentry's faulty OpenAI integration to prevent instrumentation failures in model-provider requests.

### Tests

- Add regression coverage for subagent profile token defaults, model-requested increases, tool schema behavior, and disabled OpenAI instrumentation.

## [1.0.0-beta.32]

### Changed

- Raise the autonomous event and trigger run cost stop-loss from $2 to $10 while retaining the 10-minute and 50-call limits.
- Allow session memory dreams to make up to 10 LLM calls and remove their fixed cost cap while retaining the two-minute limit.

### Fixed

- Prevent large conversations from becoming permanently unable to reset or rotate when preserving memory necessarily exceeds a fixed cost threshold.

## [1.0.0-beta.31]

### Changed

- Allow attachments to use each sandbox executor's standard file reader while retaining workspace path containment.

### Fixed

- Restore HTML, image, and document uploads from managed sandboxes that cannot provide atomic symlink-free traversal.

### Tests

- Add end-to-end regression coverage for staging and uploading workspace files through the regular executor transport.

## [1.0.0-beta.30]

### Added

- Add role-based subagent profiles for software engineering, DevOps, data science, account management, business development, creative production, advertising operations, and bounded general work.
- Add a generated cross-module hardening report covering module boundaries, coupling, and verification evidence.

### Changed

- Stabilize exported module interfaces and route executor-dependent file staging through the active execution transport.
- Deepen progressive response rendering and keep Slack E2E turns bound to the runner lifecycle.

### Fixed

- Prevent extension packages, attachment bridges, vault keys, sandbox paths, and event inputs from escaping their intended boundaries.
- Close runner construction, cached-runner invalidation, Gondolin projection, and automatic Session Dream settlement races.
- Validate model identifiers, event timezones, package refreshes, and shared-history watermarks consistently.
- Keep reset history bounded by reset time and exclude queued future turns from session history.
- Prevent Slack from posting bare working-indicator updates.

### Security

- Harden Git package materialization, extension subpaths, filesystem bridges, and sandbox path validation against traversal and symlink escapes.

### Tests

- Add regression coverage for declaration surfaces, session history boundaries, runtime races, event validation, package materialization, and Slack runner integration.

## [1.0.0-beta.29]

### Added

- Add Git-sourced extension packages with global and conversation scopes, package mount resolution, CLI inspection, and admin portal management.
- Add native Slack markdown-block responses and the `slack_blockkit` tool for interactive Block Kit messages.
- Add interactive Block Kit APIs for extensions, with a poll extension example.
- Add named subagent profiles, built-in workflow specialists, per-profile tool grants, and a bounded Slack progress dashboard.
- Preserve durable memory with Session Dream before biweekly shared-channel session rotation, using the same conversation-scoped maintenance path as `/new`.

### Changed

- Run Gondolin runtimes inside the mikan process instead of detached workers. Restarts now boot fresh VMs on demand, and shutdown closes every VM so projected files sync back first.
- Remove Gondolin runtime inventories, worker heartbeats, and the `stateDir` argument from `configureGondolinRuntime`.
- Render standard GFM response prose as native Slack markdown blocks while keeping progressive response updates behind a single lifecycle.

### Fixed

- Keep the current session active and preserve saved memory when Session Dream cannot finish.
- Bound subagent cancellation, invocation modes, profile labels, and Block Kit payloads; clamp long labels with an ellipsis instead of rejecting calls.
- Show the selected subagent profile and its tool grant consistently in progress output.
- Render the Slack subagent dashboard as a response source rather than escaped mrkdwn.
- Isolate Git test fixtures from an ambient `GIT_DIR`.

### Tests

- Add coverage for extension packages, extension Block Kit APIs, native Slack rendering, subagent profiles and progress, Session Dream rotation, and in-process Gondolin lifecycle behavior.

## [1.0.0-beta.28]

### Removed

- Remove Gondolin remote-worker and fleet support. `sandbox.gondolin.remote`, `gondolin:remote`, and `--worker-token` are no longer supported; use the local `gondolin:default` sandbox instead.

### Fixed

- Preserve Slack mrkdwn links whose labels contain spaces when rendering Block Kit responses.
- Reuse the existing Slack progress message when streaming the final response, preventing duplicate or partially completed bot messages.

## [1.0.0-beta.27]

### Added

- Preserve concrete long-term memory before `/new` creates a fresh DM session, while keeping transient context and pre-reset platform history out of the new model context.

### Changed

- Serialize workspace-mutating tools and memory-maintenance runs so file updates, resets, and incoming messages have deterministic ordering.
- Align extension context and message hooks with the active agent lifecycle, including per-run system prompt rewrites that preserve dynamically rebuilt memory, skills, and sandbox context.

### Fixed

- Keep extension-rewritten messages consistent across tool execution, persistence, provider context, and lifecycle events.
- Account for compaction model usage in run budgets and reject corrupted session trees instead of silently accepting broken history.
- Wait for active runs before resetting sessions, and prevent old runs from writing after `/new`.
- Keep long Slack continuations in their thread and preserve mrkdwn links when rendering Block Kit text.

### Tests

- Add real Slack coverage for memory-preserving `/pi-new`, long threaded responses, and Block Kit markdown links.
- Add regression coverage for harness message identity, dynamic prompts, compaction budgets, session integrity, runtime settlement, and mutation-tool ordering.

## [1.0.0-beta.26]

### Fixed

- Make the subagent tool schema compatible with OpenAI by exposing an object at the function parameter root.

### Tests

- Add regression coverage for OpenAI-compatible subagent function schemas.

## [1.0.0-beta.25]

### Changed

- Temporarily remove the Agent Sandbox runtime, SDK, Kubernetes client, Helm deployment, runtime images, and related release workflow from the npm release.
- Restore the Gondolin, Gondolin remote-worker, and Firecracker sandbox implementations while Agent Sandbox packaging is redesigned separately.

### Fixed

- Restore global npm installation and CLI startup after the broken Agent Sandbox dependencies in `1.0.0-beta.23` and `1.0.0-beta.24`.

### Tests

- Add a real `npm install -g --prefix` smoke test for the packed tarball, enforce a 2 MiB size ceiling, and gate CI and npm publishing on the result.

## [1.0.0-beta.24]

### Fixed

- Bundle the vendored Agent Sandbox SDK in the npm package so global installs no longer fail on a missing repository-local tarball.
- Reuse mikan's direct Kubernetes client dependency as an SDK peer instead of recursively bundling a duplicate dependency tree, keeping the published tarball under 1 MiB.

### Tests

- Add a pack-install smoke test that imports the bundled SDK, runs the packed CLI, enforces a 2 MiB size ceiling, and gates both CI and npm publishing.

## [1.0.0-beta.23]

### Added

- Add Kubernetes Agent Sandbox execution with mandatory `kata-qemu` isolation, a pinned TypeScript client, managed idle cleanup, and shared workspace support.
- Add a Helm chart with GKE Standard, Linux k3s, Colima, and router-only profiles; GKE supports Filestore CSI on an explicitly configured VPC.
- Publish mikan, the Agent Sandbox runtime, and the pinned router source build to GHCR through a release-aware image workflow.
- Expose detailed subagent input, output, cache, reasoning, and cost usage while retaining the existing summary aliases.

### Changed

- Replace Gondolin and Firecracker sandbox modes with `agent-sandbox:<warm-pool>`.
- Make Helm the supported Kubernetes deployment interface; the default and Colima profiles use host execution, while GKE and k3s profiles require Kata and RWX storage.
- Include delegated subagent usage in parent run statistics and budget accounting.

### Removed

- Remove the standalone `mikan-worker`, remote worker fleet, dial-home gateway, Gondolin runtime, Firecracker executor, worker CI, and worker release binaries. Existing Gondolin deployments must move to the Agent Sandbox Helm deployment; no automatic deployment or state migration is provided.

### Security

- Require Kata rather than silently falling back to runc, restrict the optional router to the configured mikan namespace with a NetworkPolicy, and keep generated PVCs by default on Helm uninstall.
- Update transitive `js-yaml` to 4.3.0 to address the merge-key chain denial-of-service advisory.

### Tests

- Add Agent Sandbox unit coverage, Helm profile assertions, pinned router image builds, and full GKE validation covering Kata, Filestore RWX, browser recording, aborts, recovery, Slack, and LLM tool execution.
- Add coverage for detailed subagent usage, compatibility aliases, failure paths, extension results, and parent budget accounting.

## [1.0.0-beta.22]

### Added

- Let subagents opt into a normalized reference snapshot of the active parent conversation with `parentContext`, while keeping fresh isolated context as the default.

### Changed

- Raise default subagent limits from 8 to 100 turns, $0.50 to $10, and 2 to 10 minutes; return concrete budget or timeout reasons.
- Apply the process-wide subagent concurrency ceiling to both tool- and extension-initiated runs, with cancellation while queued and usage attribution only to the active parent run.
- Use collision-safe hashed keys for credential authorization and runtime resources. Exact legacy host and shared-container credentials remain readable, but users of ambiguous legacy managed-sandbox keys may need to run `/login` again.
- Reject unsupported vault file mounts and mounts that overlap workspace or other credential targets.
- Extract workspace projection and session lifecycle responsibilities into focused modules without intended runtime behavior changes.

### Fixed

- Reject session keys belonging to another conversation and unsafe conversation or thread identifiers.
- Prevent session pointers and thread files from escaping their owning directory or resolving through symlinks.
- Process Slack messages posted by known human users through user tokens even when Slack includes the posting app's `bot_id`; bot-authored messages remain ignored.
- Clearly report subagent budget exhaustion instead of returning a generic incomplete status.

### Tests

- Add Slack E2E coverage for DMs, idle stop, thread isolation, busy queues, images, and multi-file uploads.
- Add unit coverage for session identity and path safety, collision-safe sandbox identities, vault mount policy, session lifecycle, normalized subagent context, shared slots, cancellation, and budget reporting.

## [1.0.0-beta.21]

### Added

- Fold each subagent's tokens and cost into the parent run's tally (`MikanAgentSession.recordExternalUsage`), so delegated spend counts against the parent run's budget instead of staying invisible to it.
- Add a process-wide subagent fan-out ceiling shared across conversations.
- Add `mikan --help` and a generated `mikan env` inventory from the daemon environment manifest.
- Make the working-directory argument optional, defaulting to `<state-dir>/workspace`.
- Add a public Gondolin runtime bootstrap seam for embedders.

### Changed

- Subagent runs never reject: request validation failures (unknown tools, invalid budgets, empty tasks, nested runs) now resolve to `failed` results, so one bad request in a `tasks`/`dag` batch can no longer orphan in-flight sibling subagents.
- Cap parallel `tasks[]` batches at 4 concurrent subagents (the same limit as DAG mode) and run DAG waves through a slot pool instead of chunk barriers.
- Report a subagent final response with no text as `failed` instead of `completed` with empty output.
- Enforce parent budgets immediately when subagent usage is folded into the parent run.
- Apply one state-directory precedence rule across boot, extensions, Sentry, and runtime readers.
- Refuse model and sandbox settings updates while a conversation is busy, and invalidate affected cached runners consistently.
- Drive PM2 environment configuration from `~/.mikan/mikan.env` instead of inline secrets.

### Fixed

- Harden Gondolin dial-home reconnects after transport failures and stale sessions.
- Reject invalid one-shot event timestamps consistently across all event writers.
- Apply global model settings to idle conversations and report busy conversations as stale.

### Security

- Keep PM2 secrets in an owner-only file outside repository trees and make the PM2 template supervision-only.

### Tests

- Add coverage for subagent accounting and concurrency, CLI and environment manifests, settings mutation, Gondolin reconnects and contracts, event formatting, and worker state layout.

## [1.0.0-beta.20]

### Fixed

- Validate subagent `outputSchema` correctly when it arrives as plain JSON Schema (the only form tool calls can carry), instead of throwing `ValueCheckUnknownTypeError` because it lacks TypeBox's `Kind` metadata.

### Tests

- Add coverage for plain JSON Schema hydration, nested objects, arrays, unions, and validation failures.

## [1.0.0-beta.19]

### Added

- Add fresh in-memory subagents for the main agent and extensions, with explicit tools, budgets, structured output, parallel batches, and bounded DAG orchestration.
- Stream debounced subagent node progress through the shared Slack, Discord, and Telegram response lifecycle.

### Changed

- Let final responses at the LLM-call cap complete without tripping the run budget when no continuation is required.

### Fixed

- Install worker binaries from the newest GitHub release that contains a matching asset, including prereleases.
- Restore generic Google Workspace CLI credential mounts in sandbox vaults.

### Tests

- Add coverage for subagent isolation, recursion guards, budgets, structured output, parallel execution, DAG validation and dependency flow, and platform-neutral progress rendering.

## [1.0.0-beta.18]

### Added

- Add an idempotent Debian and Ubuntu worker-host initialization script.
- Add persistent `mikan-worker` installation as a delegated systemd service.
- Add NFS export detection with OS-specific setup guidance for `gondolin:remote` workspaces.
- Ship host-side vault credential files securely to remote workers without placing them in the shared workspace.
- Add bounded shared-workspace health probes and worker degradation reporting.

### Changed

- Require each Gondolin remote gateway and static worker to declare its shared `workspaceRoot`.
- Exclude workers with unhealthy shared workspaces from new placements and restore them after a healthy heartbeat.

### Fixed

- Fail remote execution with actionable diagnostics instead of hanging on dead shared-workspace mounts.
- Create runtime cgroups beneath the worker's delegated cgroup and report missing `Delegate=yes` configuration.
- Verify downloaded worker binaries against the matching release checksum filename.
- Validate `gondolin:remote` only after gateway and worker transports are configured.

### Security

- Materialize remote credential files as owner-only, read-only runtime files outside shared workspaces.

### Tests

- Add coverage for worker host services, cgroup delegation, workspace health, credential delivery, NFS advice, remote validation, and idle execution deadlines.

## [1.0.0-beta.17]

### Added

- Add `gondolin:remote` for scheduling sandbox runtimes across a fleet of Linux/KVM workers.
- Add a standalone `mikan-worker` daemon with mutual TLS, fenced leases, crash recovery, capacity-aware placement, draining, and sticky conversation assignment.
- Add dial-home worker enrollment through one-time join tokens and a mikan-hosted gateway.
- Add private workspace projection, vault injection, resource limits, lifecycle reconciliation, and drift recovery to Gondolin runtimes.
- Add worker installation, enrollment, operations, and remote quickstart documentation with a one-command end-to-end smoke test.
- Publish `mikan-worker` binaries and checksums with GitHub releases.

### Changed

- Rename the preview sandbox mode from `microvm:default` to `gondolin:default` and the image build command to `npm run gondolin:image:build`.

### Fixed

- Project mounted files correctly into Gondolin guests.
- Refresh rotated credentials when Gondolin runtimes are recreated.

### Security

- Authenticate remote workers with mutual TLS and fence stale workers through expiring leases.
- Keep enrollment tokens one-time and store worker credentials privately.

### Tests

- Add coverage for Gondolin lifecycle, workspace isolation, vaults, resource controls, fleet scheduling, gateways, enrollment, workers, leases, and remote execution.

## [1.0.0-beta.16]

### Added

- Add a preview `gondolin:default` sandbox backed by Gondolin and QEMU.
- Add a curated microVM guest image build with Node.js, Python, uv, Git, ripgrep, fd, jq, SSH, and build tools.
- Manage one process-local microVM per conversation with idle shutdown and recreation on demand.

### Changed

- Broaden the coverage gate across all source modules.

### Fixed

- Keep top-level Slack file uploads out of threads.

### Tests

- Add coverage for microVM execution and lifecycle, events, logging, disabled vaults, channel storage, and core file and shell tools.

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
