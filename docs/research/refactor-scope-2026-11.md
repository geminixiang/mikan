# Refactor scope (2026-11)

The owner reviewed every feature and decided what stays. Each change below still goes through the AGENTS.md steps (research, acceptance eval on `main`, implementation, verification); this record fixes only the scope.

Evidence used during the review: [memory-capture-removal-2026-11.md](memory-capture-removal-2026-11.md), [browser-tool-vs-cli-2026-11.md](browser-tool-vs-cli-2026-11.md), and tool-call counts from a production deployment since 2026-09-15 (bash 24k, read 5.4k, react 1.1k, attach 0.8k, event 0.4k, the browser tool 0.3k, web_fetch 0.2k, history 0.2k, jev 0.1k, `slack_blockkit` 76 calls and 117 clicks, generate_image 6).

## Kept unchanged

| Area                 | Kept                                                                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platforms            | Slack, Telegram, Discord, GitHub (GitHub to be redesigned later)                                                                                           |
| Slack                | Channel @mention, channel auto-reply (on, off, jev)                                                                                                        |
| Sessions             | DM top level and each thread as its own session (current model)                                                                                            |
| Web                  | Admin portal, session viewer, `/pi-desktop`                                                                                                                |
| Memory and knowledge | Workspace and office `MEMORY.md`, `skills/`, public/private office visibility                                                                              |
| Tools                | bash, read, write, edit, attach, history, web_fetch, event, generate_image, react, jev, sandbox (the agent's tool; people no longer have a command for it) |
| Commands             | stop, new, model, compact, autoreply, login, session, desktop, admin                                                                                       |
| Operations           | Sentry, OTLP, `mikan migrate` from 0.5.3                                                                                                                   |

## Removed

| Item                                                                | Note                                                                                                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jev_browser`                                                       | The model uses the `agent-browser` CLI and its version-matched skill instead (browser-tool-vs-cli-2026-11.md)                                                                           |
| `host` and `container:` sandboxes                                   | Only `oci:` remains; tests need a local execution env of their own                                                                                                                      |
| Embedder package interface                                          | `src/index.ts` exports and `deploy/examples/embedder`; the package becomes the CLI. Removed 2026-11-22 ([embedder-interface-removal-2026-11.md](embedder-interface-removal-2026-11.md)) |
| Slack assistant pane                                                | Needs a paid plan; hardcoded greeting and suggested prompts. Removed 2026-11-11; the working status stays                                                                               |
| `/sandbox` command                                                  | Status and boost for people; the agent keeps its `sandbox` tool. Removed 2026-11-11 with `sandbox.boost`                                                                                |
| The prompt line telling the model to use `jev` "whenever" it judges |                                                                                                                                                                                         |

## Redesigned

| Item                     | Direction                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background work          | Replace `start_task`/`task_status`, the Jev task-intent classifier and its canned replies with background shell jobs in the same session, modeled on Claude Code's background commands and `pi-bg-bash`: start a job, keep talking, the job's exit and output tail wake the agent. `event` stays for schedules that survive restarts |
| Identity and credentials | Credentials belong to the person, not the office: personal secrets injected into the sandbox (the Vault, its portal renamed from `/login` to something like `/secret` or `/connector`), personal MCP servers connected with API keys or OAuth through `pi-mcp`, OpenConnector both auto-provisioned and added by hand                |
| `slack_blockkit`         | Keep only for interactive elements (buttons, menus); ordinary formatting is already Markdown rendered by the adapter                                                                                                                                                                                                                 |

## Order

The owner's instruction on 2026-11-22 was to simplify the whole design and keep the core robust. That is this scope, finished deletions first, so that each later change has less to preserve. Robustness adds no machinery: each item's acceptance eval carries the failure paths it touches (a restart mid-run, a stopped container, a replayed tool call), and only what a baseline shows broken is fixed.

| #   | Item                                                                                            | Why here                                                                                      |
| --- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Embedder package interface                                                                      | Pure deletion; afterwards no exported type is a promise                                       |
| 2   | Runtime services that were optional only for embedders                                          | Follows from 1; found with `npm run knip:unused`                                              |
| 3   | `host` and `container:` sandboxes                                                               | The largest deletion; tests first need a local execution env of their own                     |
| 4   | Background jobs ([background-jobs-2026-11.md](background-jobs-2026-11.md), C1)                  | The only item that adds code, so it lands on the smaller base; removes the `start_task` stack |
| 5   | `slack_blockkit` for interactive elements only; the `jev` "whenever" prompt line                | Small prompt and tool changes                                                                 |
| 6   | Identity and credentials                                                                        | The widest redesign; needs its own research                                                   |
| 7   | Behavior-changing candidates left in [simplify-modules-2026-10.md](simplify-modules-2026-10.md) | Its line numbers are stale; rerun `knip:unused` and `duplication` after each deletion above   |

Items 3 to 6 change the path a Slack message takes, so each needs the owner's approval for a run of the Slack E2E workflow. Item 4 also needs production `start_task` counts.

## Open

- Where the browser appears on the office desktop once `jev_browser` is gone. Deferred: nobody has used the desktop yet (production predates it, local daemons show no use), so the CLI's browser stays headless until a need appears; the desktop itself stays.
- What Admin and the session viewer are for.
- The GitHub adapter redesign.
