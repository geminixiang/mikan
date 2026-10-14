# One GitHub agent with tasks in worktrees (2026-10)

First pass. Sources: `src/adapters/github/` (README, DESIGN.md, `bot.ts`, `context.ts`, `github-ops.ts`, `tool-pack.ts`), `src/office/index.ts`, `src/sessions/session-key.ts`, `src/sessions/session-store.ts`, `src/adapters/slack/bot.ts`, `src/sandbox/provisioner.ts`, [ADR 0015](../adr/0015-github-agent-account-and-webhooks.md), [ADR 0016](../adr/0016-host-sandbox-trust-boundary.md), [ADR 0021](../adr/0021-tasks-as-background-child-conversations.md), [task flow in the runtime](task-flow-in-runtime-2026-10.md).

## Goal

Today every GitHub issue or PR is its own office: its own clone, sandbox, and memory. The target, built in layers so each ships alone:

| Layer | What                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------- |
| 1     | All configured repositories are served by one GitHub office; each issue or PR is a task working in its own worktree |
| 2     | A mention brings in the comments the agent has not seen                                                             |
| 3     | CI results and reviews on the task's own pull request wake the same task                                            |
| 4     | A task can schedule its own follow-up with the existing scheduled events                                            |
| 5     | A main agent routes events to tasks, only if rules prove too rigid                                                  |

This document covers layer 1.

## Today

| Concern             | Code                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Office identity     | `buildGithubConversationId` → `GH_<owner>_<repo>_<number>`; `parseGithubConversationId` recovers the issue from the office ID                                                |
| Who reads the issue | `bot.ts` (`postMessage`, `updateMessage`, `addReaction`), `context.ts`, and six operations in `github-ops.ts` parse the office ID                                            |
| Session             | `persistentTopLevel: true`: the whole issue is the office's one session; queue key is the office ID                                                                          |
| Follow-ups          | `isParticipating`: the office log exists                                                                                                                                     |
| Repository          | The agent clones inside its sandbox; the host runs no git (ADR 0016, guard `github-adapter-runs-no-host-processes`). Running git inside the sandbox from the host is allowed |
| Tasks               | Storage is generic (`SessionStore.openTask`, `listTasks`, `isTask`); starting, queueing, resuming, status, and reply routing live in the Slack adapter                       |
| Production          | GitHub is not enabled; two old test offices remain. The adapter is experimental, outside the 1.0 semver promise                                                              |

## Unknowns and first answers

| #   | Unknown                                                 | First answer (source)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| U1  | Who may make the agent touch which repository?          | Today a trigger needs write access to that repository, and the office holds only that repository. With one office, a person with write access to repository A can ask the agent to read private repository B, and every task sees every clone in the shared sandbox. Per-run credential scoping does not help, because the files are already in the container. The trust unit becomes "everyone who may trigger any configured repository" |
| U2  | Issue as a thread session or as a task?                 | A thread session (as Slack channel threads) needs no new flow but is not resumed after a restart. A task (ADR 0021) resumes and reports its outcome to a requester, but the task flow lives in the Slack adapter, so it must first move into the runtime (candidate B of the task-flow research)                                                                                                                                           |
| U3  | Session key per issue                                   | `makeThreadSessionKey(officeId, "<owner>_<repo>_<number>")`; the suffix only forbids path separators (`session-key.ts`)                                                                                                                                                                                                                                                                                                                    |
| U4  | How do operations find the issue without the office ID? | `PlatformToolPack.bindRun` already receives `threadTs` (Slack uses it); the GitHub context and responder get the issue from the event's thread, not the office                                                                                                                                                                                                                                                                             |
| U5  | Who creates the worktree?                               | Either the agent by a path convention in the prompt, or mikan running `git worktree add` inside the sandbox before the run (allowed by ADR 0016). To compare in a POC                                                                                                                                                                                                                                                                      |
| U6  | Resources                                               | One sandbox now runs every GitHub task under one limit (production: 1 CPU, 4 GB; boost 2 CPU, 6 GB on a 2 vCPU host). Concurrent tasks share it                                                                                                                                                                                                                                                                                            |
| U7  | Memory                                                  | One `MEMORY.md` for all repositories; repository facts need a home, for example a notes file per repository                                                                                                                                                                                                                                                                                                                                |
| U8  | Follow-ups                                              | `isParticipating` must become per issue: the issue's session exists                                                                                                                                                                                                                                                                                                                                                                        |
| U9  | Existing data                                           | No migration needed in production; old `GH_<owner>_<repo>_<number>` offices can stay as read-only history                                                                                                                                                                                                                                                                                                                                  |

## Open decisions

1. U1, decided: the trust unit is the agent's own GitHub access. The agent is an account granted access to repositories, like a teammate; whoever can mention it in a private repository already has access to that repository, and the office layout is not a security boundary. No grouping setting.
2. U2, decided: each issue or PR is a thread session in the GitHub office, as Slack channel threads, on the condition that an interrupted session can be resumed. Today a run is interrupted only when it outlives the 5-minute shutdown drain or the process crashes; mikan then aborts it at open (ADR 0021 decision 5), although pi-durable can continue it when the session is bound before the scheduler runs (task-flow research, native-resume POC). Production 2026-10-01 to 10-13: 27 restarts, no unfinished work aborted. Native continuation for every session came first, as its own change ([ADR 0027](../adr/0027-interrupted-runs-continue-after-restart.md)).
3. U5: who creates the worktree.

## Identity, decided separately

The agent will move from a bound user account (ADR 0015) to a GitHub App, so it takes no seat and follows GitHub's integration model. As of 2026-10 an ordinary App bot is not offered in @-mention autocomplete and cannot be assigned; GitHub's agent apps can, but they run on Copilot cloud agent, need a paid Copilot plan, and building one is waitlisted (docs.github.com, "About agent apps"). People will type the App's mention or use a trigger the App can see. This is a separate change with its own ADR superseding ADR 0015, and layer 1 does not depend on it.

## Next

Second pass after the decisions: measure clone and worktree cost in the `image` sandbox, check concurrent tasks in one sandbox, and list every place that reads the issue from the office ID.
