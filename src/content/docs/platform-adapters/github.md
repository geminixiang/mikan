---
title: GitHub adapter
description: A bound GitHub account driven by webhooks, issue/PR conversations, restrictions, and comment-based responses.
---

One GitHub issue or pull request is one mikan conversation. mikan acts as a regular GitHub account that you bind to it, so people mention it with autocomplete, assign it issues and pull requests, and request its review like a teammate. Signed webhooks tell mikan what happened. See [ADR 0015](https://github.com/geminixiang/mikan/blob/main/docs/adr/0015-github-agent-account-and-webhooks.md) for why.

For step-by-step setup, see [Make mikan a GitHub teammate](/github-teammate-guide/).

The conversation id is `GH_<owner>_<repo>_<number>` with owner and repo lowercased. It avoids `/` and `:` because ids are used verbatim as one path segment and in docker's `-v source:target` syntax, and it separates on `_` rather than `-` because GitHub owners may contain `-` (which would make the owner/repo boundary ambiguous) but never `_`. Like every platform, the raw id stays at the GitHub API boundary: on disk the conversation lives in an office directory named by office key.

## Main code

| File                                | Purpose                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/github/bot.ts`        | GitHub bot core: trigger decisions, permission checks, conversation intake.                                           |
| `src/adapters/github/activity.ts`   | Validates webhook payloads and normalizes them into one activity shape.                                               |
| `src/adapters/github/policy.ts`     | Parses and applies the restriction settings.                                                                          |
| `src/adapters/github/webhook.ts`    | Verifies signatures, answers GitHub, and drops repeated deliveries.                                                   |
| `src/adapters/github/github-ops.ts` | The host-side backends behind every `github_*` tool.                                                                  |
| `src/adapters/github/client.ts`     | Minimal REST client authenticated with the agent account's token.                                                     |
| `src/adapters/github/context.ts`    | Creates the GitHub `ConversationResponder`; posts the finished response as one comment (no streaming edits).          |
| `src/adapters/github/ids.ts`        | `rc-<id>` review-comment ts. The `GH_<owner>_<repo>_<number>` conversation id grammar lives in `src/office/index.ts`. |
| `src/adapters/github/tool-pack.ts`  | Bundles the host-side tools as a platform tool pack injected from main.                                               |
| `src/adapters/github/tools/`        | The agent-facing tools: `github_pr`, `github_checks`, `github_review_reply`, `github_read`, `github_issue`.           |

## Requirements

- **An agent account**: a regular GitHub user account for mikan, with access to the repositories it should work in. Its role in each repository is an outer limit: read where it only talks, write where it pushes branches.
- **A fine-grained personal access token** of that account, with the organization as resource owner and these repository permissions: **Contents**, **Issues**, and **Pull requests** read & write; **Actions** and **Commit statuses** read. If the organization requires approval, an owner approves it.
- **A webhook** to `<LINK_URL>/github/webhook` with a secret, subscribed to **Issues**, **Issue comments**, **Pull requests**, and **Pull request review comments**. An organization webhook is the simplest; a GitHub App webhook also works, and mikan uses no App credentials.
- **The link server** (`LINK_PORT` and a public `LINK_URL`), which receives the webhook.

## Configuration

| Env var                 | Purpose                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `GITHUB_AGENT_TOKEN`    | The agent account's fine-grained PAT (required). Startup fails if GitHub rejects it.      |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret (required).                                                            |
| `GITHUB_REPOS`          | Comma-separated `owner/repo` or `owner/*` (required). Nothing else is answered.           |
| `GITHUB_PUBLIC_REPOS`   | `true` to also answer in public repositories (default `false`).                           |
| `GITHUB_USERS`          | Comma-separated logins allowed to trigger (default: anyone with the required permission). |
| `GITHUB_MIN_PERMISSION` | Repository permission a trigger needs: `write` (default), `maintain`, or `admin`.         |
| `GITHUB_TRIGGERS`       | Any of `mention`, `assign`, `review`, `followup` (default all).                           |
| `GITHUB_CAPABILITIES`   | `triage` and/or `push` beyond commenting (default none).                                  |

An unknown value in any of these fails startup.

## Triggering

A delivery triggers a run only when all of these hold:

1. The sender is not a bot and not the agent account itself.
2. The repository matches `GITHUB_REPOS`, and is private unless `GITHUB_PUBLIC_REPOS=true`.
3. It is an enabled trigger:
   - `mention`: a new issue, pull request, comment, or inline review comment mentions `@<agent-login>`;
   - `assign`: an issue or pull request is assigned to the account;
   - `review`: the account's review is requested on a pull request;
   - `followup`: a new comment arrives in a thread mikan already takes part in.
4. The sender is listed in `GITHUB_USERS`, when set.
5. The sender holds `GITHUB_MIN_PERMISSION` on the repository. Lookups are cached for five minutes and fail closed.

Everything else is ignored without creating any state. A mentioned `stop` (or `/stop`) comment stops the running session; the magic word uses one grammar across all platforms.

Delivery is best effort. mikan answers GitHub immediately, ignores a repeated delivery, and keeps no delivery records. Events sent while mikan is down or unreachable are lost; mention the account again.

## Capabilities

Without `GITHUB_CAPABILITIES`, mikan comments, reacts, reads the repository and CI results, and replies in review threads. It cannot change labels, assignees, or code.

| Capability | Adds                                                                           |
| ---------- | ------------------------------------------------------------------------------ |
| `triage`   | The `github_issue` tool: labels, assignees, close and reopen.                  |
| `push`     | The `github_pr` tool and instructions to push branches and open pull requests. |

A capability that is off removes its tool and its instructions from the agent entirely. It does not take credentials away: what the agent can push from its sandbox is decided by the sandbox's GitHub token, the account's repository role, and branch protection. Protect the default branch so that changes land only through reviewed pull requests.

Only collaborators with at least write access trigger mikan, so GitHub reports `trustModel: "membership"`. GitHub conversations therefore receive `sandbox.defaultSharedVault`, settings-declared MCP servers, and the default OpenConnector token like Slack conversations. See [Vault](/sandbox/vault/).

## Sessions and replies

The whole issue/PR is one persistent session (`sessionKey === conversationId`), including inline review threads, which are flattened into it rather than mapped to sub-sessions. A triggering review comment is injected as a message tagged `[PR review comment rc-<id> on <path>:<line>]` carrying the diff hunk and, for mid-thread replies, the thread's earlier turns; the agent answers that thread with the `github_review_reply` tool (a plain response posts as a normal PR comment). Responses are GitHub Flavored Markdown, posted after the response is finished: no streaming edits, so replies don't churn the API or show as "edited". Output that exceeds the comment split threshold is posted as continuation comments. First contact through a comment logs the issue title and body ahead of it so the session knows what the thread is about.

## Repository access and pull requests

mikan never runs git on the host. The agent clones the repository into its scratch directory, checks out a pull request with `gh pr checkout`, commits as the agent account, and pushes, all inside its sandbox with the sandbox's GitHub credentials. Without credentials only public repositories are reachable.

- `github_pr` (capability `push`) opens a pull request (draft supported) for a branch the agent already pushed; if the branch already has an open PR, it returns that PR. It never pushes and cannot merge.
- `github_checks` reads GitHub Actions jobs and commit statuses for a pushed branch or the PR head, and fetches an Actions job's log tail by `job_id`. Fine-grained tokens have no Checks permission, so check runs published by third-party CI apps are not visible.
- `github_review_reply` posts a reply inside one inline review thread.
- `github_read` reads PR state and diff stats, changed files, reviews, issue metadata, comments, and a filtered issue/PR listing of the conversation's repository.
- `github_issue` (capability `triage`) manages labels, assignees, and close/reopen. Lock, delete, and transfer are not in its action set.

## Limitations

- Missed webhook deliveries are not replayed.
- File uploads are not supported by the REST API; `uploadFile` posts a pointer comment instead.
- A PR review whose summary body alone mentions the account (with zero inline comments) does not trigger. Request the account's review, or comment instead.
