---
status: accepted
---

# GitHub runs through a bound agent account, driven by webhooks

The GitHub adapter requires the operator to bind a regular GitHub user account to mikan, called the agent account. People work with it the way they work with a teammate: they @-mention it with autocomplete, assign it issues and pull requests, and request its review. mikan acts on GitHub only as that account.

Events arrive as signed GitHub webhooks. Delivery is best effort: a missed event is recovered by mentioning the account again, not by replay machinery. This supersedes the repository polling, the GitHub App identity, and the "webhook only pokes the poll" rule in `src/adapters/github/DESIGN.md`.

## Context

- GitHub offers an App's `slug[bot]` neither in @-mention autocomplete nor as an assignee or reviewer. Only user accounts can be assigned. The exceptions are Copilot, Agent HQ, and waitlisted agent apps, which run on Copilot's runtime instead of mikan's ([research](../research/github-agent-event-intake-2026-09.md)).
- Polling costs about four requests per repository per tick. An organization with hundreds of repositories exceeds GitHub's secondary rate limit, and a full poll takes longer than its interval.
- Every hosted agent verified in the research receives webhooks on its own endpoint.
- Polling existed so mikan could run without a public endpoint. The link server already serves one (`LINK_URL`) for `/login`.
- A person who addressed the agent notices when it does not answer and can ask again. Missing an occasional event costs less than the journals, replay, and watermarks that would prevent it.

## Decision

- **Identity**: the agent account comments, replies to review threads, reacts, opens pull requests, and authors commits. The agent pushes from its sandbox with the sandbox's credentials; mikan runs no git on the host ([ADR 0016](0016-host-sandbox-trust-boundary.md)).
  - The host holds one fine-grained PAT of that account with Contents, Issues, and Pull requests read & write, and Actions and Commit statuses read.
  - The sandbox stays credential-free, and git runs host-side with the token passed per invocation.
- **Event source**: webhooks to `<LINK_URL>/github/webhook`, verified with `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET`.
  - The operator may register either an organization webhook or a GitHub App webhook. mikan receives the same payloads either way, and it uses no App credentials.
  - The webhook subscribes to Issues, Issue comment, Pull request, and Pull request review comment.
- **Triggers**, read from the payload:
  - a new issue or PR body, a comment, or a review comment that @-mentions the account;
  - `issues.assigned` or `pull_request.assigned` to the account;
  - `pull_request.review_requested` for the account;
  - any new comment in a thread that already has a mikan conversation.

  Every trigger ignores bots and the account's own actions. A review whose summary body alone mentions the account does not trigger; its inline comments and review requests do.

- **Restrictions**, default closed, from the environment:

  | Setting                 | Default                          | Limits                                             |
  | ----------------------- | -------------------------------- | -------------------------------------------------- |
  | `GITHUB_REPOS`          | required                         | Repositories, as `owner/repo` or `owner/*`         |
  | `GITHUB_PUBLIC_REPOS`   | `false`                          | Whether public repositories are answered           |
  | `GITHUB_USERS`          | anyone                           | Which logins can trigger                           |
  | `GITHUB_MIN_PERMISSION` | `write`                          | The sender's repository permission                 |
  | `GITHUB_TRIGGERS`       | `mention,assign,review,followup` | Which kinds of activity trigger                    |
  | `GITHUB_CAPABILITIES`   | none                             | `triage` (`github_issue`) and `push` (`github_pr`) |

  A capability that is off removes its tool and its instructions from the agent. The token and the account's repository role stay the outer bound. Environment variables keep these next to the other platform settings; the global `settings.json` holds agent defaults, not platform access.

- **Receiving**: verify the signature, answer 202, then process, so GitHub's 10-second timeout never waits on the agent.
  - A small in-memory set of recent delivery GUIDs (`X-GitHub-Delivery`) drops manual redeliveries.
  - Nothing about deliveries is persisted.

## Considered Options

- **Agent account with best-effort webhooks (chosen)**: this follows the industry pattern, the account is how people address mikan, and there is no delivery state to keep.
- **Guaranteed delivery**: journal each delivery before acknowledging it, and replay failed deliveries through the App's delivery API. This prevents loss during downtime but adds persistent state, App JWT credentials, and a recovery loop, to cover a case that a repeated mention already handles.
- **Agent account reading its notifications inbox** (`GET /notifications`, optionally woken by email over IMAP IDLE): needs no public endpoint and does not scale with repository count. It is still polling, requires a classic PAT, and no agent in the research does it.
- **Central webhook relay with an outbound long-lived connection**, as in Cursor's self-hosted workers: needs no endpoint on the mikan host, but the operator must run and maintain a separate relay service.
- **Keep repository polling, with the webhook poking only the named repository**: keeps one event source, but assignments need extra event polling and the design stacks several mechanisms.
- **Keep the App as the speaking identity** (commit `820246d5`): two identities appear in one thread, and mentions of the App have no autocomplete.

## Consequences

- The GitHub adapter requires the link server with a public `LINK_URL`, a webhook secret, a repository allowlist, and an agent account with a fine-grained PAT.
- Deployments that relied on the App's defaults lose triage and pull requests until they set `GITHUB_CAPABILITIES`.
- These are removed:
  - `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and the App private key;
  - `GITHUB_POLL_INTERVAL`, and `GITHUB_REPOS` as an optional poll list (it returns as the required allowlist);
  - polling and the sync watermark file.

  Mentions of `@<app-slug>` no longer trigger.

- Events sent while mikan is down or unreachable are lost. People mention the account again.
- Delivery order is not guaranteed. Each conversation's queue processes events in arrival order.
- Fine-grained PATs have no Checks permission, so CI results come from the Actions API and commit statuses. Check runs published by third-party CI apps are not visible.
- Fine-grained PATs expire. mikan fails at startup with a clear error when the token is invalid, and the operator rotates it.
- The account's repository role bounds the token: write where mikan pushes branches, read where it only talks. Branch protection on default branches stays the operator's guard, and mikan still refuses default-branch and force pushes.
- How a thread maps to an office (one office per thread today) is a separate decision.
