# Simplifying modules — survey (2026-10)

A read-only survey of `src/` on `main` at fbdbf52d for code to remove or fold together. Each candidate was checked against its callers, `git log`, and the installed pi-durable 1.3.0 / pi-ai type declarations. Line numbers are on that commit. Estimates are net production lines removed.

Baseline: `npm run duplication` finds one clone (≥70 tokens), `adapters/discord/context.ts:27-48` against `adapters/github/context.ts:58-78`. Most `knip:unused` entries are exports used inside their own file and by tests, not dead code.

## Stages

Each stage is one module group, one branch, one PR. Stages are ordered by risk; stage 0 is documentation only.

### Stage 0 — documentation fixes

- `src/adapters/slack/README.md`: the "App configuration" section appears twice.
- `src/vault/README.md:10` documents `migrateConversationVaultKeys`, removed in a7574c3a.
- `src/cli/README.md` repeats the `mikan slack` bullet and a clause inside the `onboard` bullet.
- `src/harness/README.md:305` says `inspectExecution` reads "from a copy"; it does not.

### Stage 1 — harness (≈140 lines, behavior-preserving)

| Item                                                                                                                | Where                                                                                                             | Lines |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----- |
| Drop the startup system prompt built with a fake `"chat"` platform; every `run()` sets its own before tools install | `runner.ts:266-297, 767, 801-806`; unused `conversationId` at `:338`; pass-through `prepareRunnerTurn` `:552-568` | ~45   |
| Remove the `toolArgs` map (written, never read) and inline `emitToolEnd`                                            | `session.ts:115, 329, 690, 703`                                                                                   | ~18   |
| Remove the inline-skill path, set only by a test                                                                    | `skills.ts:217, 381-388`; `types.ts:161, 166`                                                                     | ~12   |
| One `label` parameter helper instead of four copies, keeping the optional-label case                                | `pi-tools.ts:13-45`, `host-fn-tool.ts:17-37`, `mcp.ts:236-286`                                                    | ~25   |
| Move `start_task`'s `callers: ["model"]` into its definition; drop unreachable throws                               | `session.ts:438-440`, `tools/task.ts:39, 73`                                                                      | ~4    |
| Match `part.type === "toolCall"` (pi-ai's only variant) and extract tool labels once                                | `run-events.ts:8-12, 47`, `presenter.ts:435-455`, `runner.ts:654`                                                 | ~12   |
| Presenter pass-throughs and duplicate switch cases                                                                  | `presenter.ts:108-110, 798-800, 825-839`                                                                          | ~15   |
| Give scheduled-event run names one owner in `src/events/`                                                           | `events/scheduler.ts:185`; parsed at `runner.ts:256, 393`, `prompt.ts:181`, `presenter.ts:164`                    | ~5    |

### Stage 2 — adapters (≈150 lines)

| Item                                                                                                    | Where                                                                                                                                              | Lines | Note                                                                                                             |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------- |
| Remove `respondToolResult` / `formatToolResult`; no production caller since afda4ab1                    | `types.ts:50-57, 90`, `progressive-renderer.ts`, `slack/response-lifecycle.ts:65-74`, platform contexts and bots, `web/session-view/portal.ts:686` | ~55   | `ConversationResponder` loses a method; `deploy/examples/embedder` implements it. State it in the release notes. |
| One event-to-message builder in `shared.ts`, each platform passing its session-key fallback             | `discord/context.ts:26-46`, `github/context.ts:57-77`, `telegram/context.ts:25-37`                                                                 | ~25   | Clone budget drops to 0                                                                                          |
| One keyed queue map instead of four `getQueue` copies                                                   | four `*/bot.ts`                                                                                                                                    | ~25   | Keep Slack's stop rules (ADR 0027)                                                                               |
| Merge the shared tail of Slack's `handleAppMention` and `handleMessageEvent`; compute `sessionKey` once | `slack/bot.ts:1330-1355, 1543-1583`                                                                                                                | ~25   | Keep ack ordering                                                                                                |
| Share Discord/Telegram `stop`, `enqueueEvent`, log helpers                                              | `discord/bot.ts`, `telegram/bot.ts`                                                                                                                | ~20   | Low value                                                                                                        |

### Stage 3 — sessions, runtime, events (≈200 lines)

| Item                                                                                                                   | Where                                                                                       | Lines          | Note                                       |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------ |
| Remove the owner walk only the retired subagent tool needed (ca5e5816)                                                 | `session-store.ts:251-252, 290-333, 384-453`                                                | ~55 + ~45 test | Continuation path: needs Slack E2E         |
| Route `appendMessage` / `appendCustomEntry` / `appendCompactionSummary` through `appendSessionEntry`                   | `session-store.ts:677-727, 1250-1306`                                                       | ~35            |                                            |
| Remove dead and test-only API: `getContextEntries`, `settle`'s `markRunning`                                           | `session-store.ts:1169`, `session-lifecycle.ts:117-126`, four `core-interfaces.mdx` locales | ~30            |                                            |
| Move migration-only import code to `src/migrations/`; fold repeated `Harness.open` and `existsSync` guards             | `session-store.ts:729-860`                                                                  | ~20 net        | Needs an owner decision for exported types |
| `chat-history-sync.ts`: drop duplicate `sortTime`, pass-through `hasMaterializedChatSession`                           | `:36-40, 306-318`                                                                           | ~15            |                                            |
| Events: unreachable `missing_bot` branch                                                                               | `events/scheduler.ts:171-176`                                                               | ~6             |                                            |
| Runtime and `main.ts`: build the run attributes once; `resourceController` always equals `provisioner`; one purge loop | `conversation-runtime.ts:439-460`, `main.ts:300, 322-325`                                   | ~15            |                                            |

### Stage 4 — sandbox, settings, vault, observability (≈130 lines)

| Item                                                                                                    | Where                                                                                     | Lines | Note                                        |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----- | ------------------------------------------- |
| Drop `ProvisionOptions.containerName`; its only caller passes the default                               | `provisioner.ts:15-19, 106-107, 290-295`, `types.ts:319`, `execution-resolver.ts:115-144` | ~25   |                                             |
| Read drift state with one `inspect` template instead of five engine calls                               | `provisioner.ts:406-505, 626-630`                                                         | ~40   | Medium risk: run on nerdctl, Podman, Docker |
| One `rewriteSettingsFile` for three writers                                                             | `settings/index.ts:381-476`                                                               | ~20   |                                             |
| Test-only code: `linkAbortSignal`, `VaultManager.list()`; `noPlatformsMessage` reuses `envSummaryLines` | `sandbox/utils.ts:24-32`, `vault/index.ts:123-136, 503`, `env-manifest.ts:256-261`        | ~35   |                                             |
| Move the Slack names out of `recordDiagnosticEvent` into its one caller                                 | `observability/index.ts:171-195`                                                          | ~8    |                                             |

### Stage 5 — web portals (≈90 lines)

| Item                                                                                          | Where                                                                                               | Lines | Note                           |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----- | ------------------------------ |
| Admin conversation scope as `officeFromQuery` / `officeFromBody`                              | `admin/portal.ts:231-277, 896-900`                                                                  | ~30   |                                |
| One `renderStatusPage` in `portal-shell.ts`                                                   | `login/portal.ts:688-718, 1103-1109`, `session-view/portal.ts:750-771`, `admin/portal.ts:1778-1788` | ~25   | Small visual change            |
| Login portal uses `jsonResponse` / an `htmlResponse`; `oauthStates` uses `InMemoryTokenStore` | `login/portal.ts:245, 347-376, 1167-1405`                                                           | ~35   | Adds `Cache-Control: no-store` |

## Candidates that change behavior

Each needs its own decision and acceptance eval; none is in a stage above.

- Remove the "## Tools" list from the system prompt (`prompt.ts:358-371`); it repeats the descriptions Pi sends and can name absent tools.
- `conversationSettingsPath` writes `{}` on every read (`settings/index.ts:256-265`); readers already handle a missing file.
- `getSessionMessageText` via pi-ai `contentText` changes separators used in dedupe.
- Drop `existsSync` before the sandbox read in `collectMessageAttachments` (`prompt.ts:37-46`).
- One validator for event payloads changes error wording (`events/index.ts:166-243`).

## Left out on purpose

Memory-capture Jev gate (ADR 0011), Jev auto-reply and task-intent classification (recent, deliberate), MCP result limits (Pi's limits are not public), `history` CJK matching (820fa623), `jev_browser` guards, the model-catalog proxy, polling waits in the runtime (timing), `util.parseEnv` for `parseEnvFile` (strips ` #comment` from unquoted secrets), the provisioner mount-signature label.
