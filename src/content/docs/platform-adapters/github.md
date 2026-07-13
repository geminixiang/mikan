---
title: GitHub adapter
description: GitHub App polling, issue/PR conversations, watermark dedup, and comment-based responses for the GitHub adapter.
---

One GitHub issue or pull request is one mikan conversation. The adapter polls the GitHub API as a GitHub App installation — no webhook endpoint, preserving mikan's proactive model.

## Main code

| File                                | Purpose                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/github/bot.ts`        | GitHub bot core: poll loop, watermark dedup, mention/participation triggering, tool backends.                              |
| `src/adapters/github/client.ts`     | Minimal REST client authenticated as a GitHub App (RS256 JWT → installation tokens).                                       |
| `src/adapters/github/cloudbuild.ts` | Cloud Build log retrieval for `github_checks` (host-side GCP credentials).                                                 |
| `src/adapters/github/context.ts`    | Creates the GitHub `ConversationResponder`; posts the finished response as one comment (no streaming edits).               |
| `src/adapters/github/ids.ts`        | `GH_<owner>_<repo>_<number>` conversation id encode/parse; `rc-<id>` review-comment ts.                                    |
| `src/adapters/github/tools/`        | The agent-facing tools: `github_pr`, `github_checks`, `github_review_reply`, `github_sync`, `github_read`, `github_issue`. |
| `src/adapters/github/types.ts`      | GitHub adapter-specific types and REST payload shapes.                                                                     |

## Create and install the GitHub App

1. Create a GitHub App for the account or organization that owns the target repositories.
2. Grant repository permissions: **Metadata: Read**, **Contents: Read & write**, **Issues: Read & write**, **Pull requests: Read & write**, **Checks: Read**, and **Actions: Read**. Issues/PR write access covers comments and reactions; Contents/Pull requests write access is used only by the guarded `github_pr` tool.
3. Install the App on the repositories mikan may poll.
4. Record the App ID and installation ID, then generate a private key. Keep the PEM outside the workspace and prefer `GITHUB_APP_PRIVATE_KEY_PATH` over an inline secret.

The App slug is the name users mention to trigger first contact.

## Configuration

| Env var                                                  | Purpose                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`                                          | GitHub App id (required).                                                                 |
| `GITHUB_INSTALLATION_ID`                                 | Installation id to act as (required).                                                     |
| `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_PRIVATE_KEY_PATH` | App private key PEM, inline (with `\n` escapes) or as a file.                             |
| `GITHUB_REPOS`                                           | Optional comma-separated `owner/repo` list; defaults to all installation repositories.    |
| `GITHUB_POLL_INTERVAL`                                   | Optional poll interval in seconds (default 60).                                           |
| `GOOGLE_APPLICATION_CREDENTIALS`                         | Optional path to a GCP ADC JSON; enables Cloud Build logs in `github_checks` (see below). |
| `GOOGLE_CLOUD_PROJECT`                                   | Optional fallback GCP project when a Cloud Build check does not name one.                 |

## Event source

A poll loop fetches, per watched repo, issues, issue/PR comments, and inline PR review comments updated since an incremental cursor, using ETag conditional requests (304 responses are free against the rate limit). Each endpoint currently reads one page of up to 100 records; a larger burst between polls can be missed when the cursor advances. Reduce `GITHUB_POLL_INTERVAL` or narrow `GITHUB_REPOS` for busy installations.

Dedup is a persisted watermark at `<state-dir>/github-sync.json` (atomic write):

- The first run records a baseline and emits nothing — history never triggers.
- Already-handled comment/issue ids never re-trigger, and edits do not re-trigger.
- Comments posted while mikan was down replay after restart.

## Triggering

A comment, inline review comment, or new issue body triggers a run only when it @mentions the app slug, or the bot already participates in that issue's conversation. The commenter must also hold **write permission or better** on the repo — on public repos anyone can comment, so mentions from anyone below write are ignored entirely (permission lookups are cached for five minutes and fail closed). Everything else is ignored without creating any state. A mentioned `stop` (or `/stop`) comment stops the running session.

## Sessions and replies

The whole issue/PR is one persistent session (`sessionKey === conversationId`) — including inline review threads, which are flattened into it rather than mapped to sub-sessions. A triggering review comment is injected as a message tagged `[PR review comment rc-<id> on <path>:<line>]` carrying the diff hunk and, for mid-thread replies, the thread's earlier turns; the agent answers that thread with the `github_review_reply` tool (a plain response posts as a normal PR comment). Responses are GitHub Flavored Markdown, posted after the response is finished — no streaming edits, so replies don't churn the API or show as "edited". Output that exceeds the comment split threshold is posted as continuation comments. The system prompt tells the agent which issue/PR the conversation is (owner/repo#number). First contact through a comment logs the issue title/body ahead of it so the session knows what the thread is about.

## Repository access and pull requests

The sandbox never holds credentials; git spans the two sides of the conversation-dir bind mount:

- On first contact the repo is shallow-cloned into the conversation dir (`./repo` inside the sandbox) with an ephemeral token scoped to that repo and `contents:read`, passed per git invocation and never written to `.git/config`. PR conversations get the PR head checked out under its real branch name (fork PRs and failed lookups fall back to `pr-<n>`), so a PR whose head is a `pi/*` branch can be updated in place: commit on it and `github_pr` pushes back to the same PR.
- The agent branches and commits inside the sandbox with plain git (the bot's author identity is preconfigured); pushing from the sandbox fails by design.
- The `github_pr` tool runs host-side: it mints a `contents:write` + `pull_requests:write` token for that one repo, pushes the agent's `pi/*` branch from the host side of the mount, and opens a pull request (draft supported) as the App; re-invoking it with the same branch pushes new commits to the existing PR. It cannot push the default branch, force-push, or merge — humans review and merge every PR.
- The `github_checks` tool reads CI check runs for a pushed branch (or the PR head) and can fetch a failing run's log tail: `job_id` for GitHub Actions runs (requires **Checks: Read** and **Actions: Read**), `build_id` for Google Cloud Build runs when the host has GCP credentials (below).
- The `github_sync` tool refreshes the `./repo` snapshot from origin — the latest PR head, the base branch, or a named branch — with an ephemeral read token. It only moves the checkout when that cannot lose the agent's work (clean tree, no agent commits; force-pushed PR heads still sync); otherwise it fetches to `FETCH_HEAD` and reports so the agent can merge or rebase inside the sandbox.
- The `github_review_reply` tool posts a reply inside one inline review thread, taking the numeric id from an `rc-<id>` message.
- The `github_read` tool reads metadata the clone cannot show: PR state and diff stats, changed files, submitted reviews with open thread ids, issue metadata, recent comments, and a filtered issue/PR listing. It is scoped to the conversation's repo by construction.
- The `github_issue` tool manages labels, assignees, and close/reopen on any issue in the conversation's repo (triage). Lock, delete, and transfer are not in its action set.

These tools use the App permissions listed in the setup section. They cannot bypass branch/default-branch guards enforced by mikan.

## Cloud Build logs (optional)

When CI runs on Google Cloud Build, its check runs appear as external CI on GitHub and their logs are not fetchable through the GitHub API. Set `GOOGLE_APPLICATION_CREDENTIALS` on the **host** to a GCP Application Default Credentials JSON — a Workload Identity Federation `external_account` file (file or url credential source), a service-account key, or gcloud user ADC — and `github_checks` summaries will advertise `[build <uuid>]` handles whose logs it can fetch (builds.get → the `log-<uuid>.txt` object in the build's logs bucket, tail-truncated).

The credential principal needs `roles/cloudbuild.builds.viewer` on the project and `roles/storage.objectViewer` on the logs bucket. Builds configured with `CLOUD_LOGGING_ONLY` write no GCS log object; the tool then returns the console URL instead. Credentials never enter the sandbox; without them, Cloud Build checks degrade to the previous guidance text.

## Limitations

- File uploads are not supported by the REST API; `uploadFile` posts a pointer comment instead.
- A PR review whose summary body alone mentions the bot (with zero inline comments) does not trigger — there is no repo-wide "reviews since" endpoint. Post a normal PR comment instead.
- The `./repo` clone starts as a snapshot from first contact; the sandbox cannot fetch updates itself — the agent uses `github_sync` for that.
