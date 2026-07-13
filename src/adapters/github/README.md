# src/adapters/github

GitHub adapter: one issue or PR = one conversation. Polls the GitHub API as a
GitHub App installation (no webhooks, matching mikan's proactive model — see
`DESIGN.md` for the full rationale and decisions).

## Files

- `bot.ts`: `GithubMessagingBot` — MessagingBot implementation plus the poll
  loop (incremental `since` cursors, ETag conditional requests, mention /
  participation triggering) and the host-side backends for all github\_\* tools.
- `client.ts`: minimal GitHub REST client authenticated as a GitHub App
  (RS256 app JWT → cached installation tokens).
- `cloudbuild.ts`: Cloud Build log retrieval for `github_checks` (builds.get →
  GCS log object) using host-side GCP ADC from `gcp-auth.ts`.
- `gcp-auth.ts`: minimal GCP ADC token provider (WIF `external_account` STS
  exchange, service-account key, gcloud user ADC) — no google-auth-library
  dependency; lives here because Cloud Build logs are its only consumer.
- `context.ts`: per-event `ConversationMessage` / `ConversationResponder`;
  no streaming — the finished response is posted as one comment (per-delta
  edits would churn the API and mark every reply "edited").
- `ids.ts`: `GH_<owner>_<repo>_<number>` conversation id encode/parse, plus
  the `rc-<id>` message ts for inline review comments.
- `repo.ts`: host-side git operations — shallow clone into the conversation
  dir, guarded branch push (`pi/*` only, non-force, tokens per-invocation and
  never persisted), and work-preserving sync (`github_sync`).
- `tool-pack.ts`: `createGithubToolPack` — the host-side tools under
  `tools/` as a `PlatformToolPack` injected from main, not core tools.
- `tools/`: one module per agent-facing tool — `pr.ts` (`github_pr`),
  `checks.ts` (`github_checks`), `review-reply.ts` (`github_review_reply`),
  `sync.ts` (`github_sync`), `read.ts` (`github_read`), `issue.ts`
  (`github_issue`).
- `types.ts`: adapter config, REST payloads, and host tool contracts
  (`GithubPrRequest`, `PlatformGithubOps`, …) — not re-exported from root
  `adapter.ts` / `types.ts`.

## Configuration (env)

- `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` — required.
- `GITHUB_APP_PRIVATE_KEY` (PEM, `\n` escapes allowed) or
  `GITHUB_APP_PRIVATE_KEY_PATH` — required, one of.
- `GITHUB_REPOS` — optional comma-separated `owner/repo` list; defaults to
  every repository the installation can access.
- `GITHUB_POLL_INTERVAL` — optional poll interval in seconds (default 60).
- `GOOGLE_APPLICATION_CREDENTIALS` — optional path to a GCP ADC JSON (a
  Workload Identity Federation `external_account` file, a service-account
  key, or gcloud user ADC). When set, `github_checks` can fetch Cloud Build
  logs; credentials stay host-side, the sandbox never sees them. The ADC
  principal needs `roles/cloudbuild.builds.viewer` on the project and
  `roles/storage.objectViewer` on the logs bucket.
- `GOOGLE_CLOUD_PROJECT` — optional fallback project when a Cloud Build
  check's `details_url` does not name one.

## Behavior notes

- Session scope: the whole issue/PR is one persistent session
  (`sessionKey === conversationId`). Inline PR review comments are polled
  (`/pulls/comments`) and injected into the same flat session as messages
  tagged `[PR review comment rc-<id> on <path>:<line>]` with the diff hunk
  and (for replies) the thread's earlier turns; the agent answers in-thread
  with `github_review_reply`. A review whose summary body alone mentions the
  bot (zero inline comments) does not trigger — there is no repo-wide
  "reviews since" endpoint; the reviewer can post a normal comment instead.
- Triggering: a comment triggers only when it @mentions the app slug or the
  bot already participates in that issue (its conversation dir has a
  `log.jsonl`), and the commenter holds **write permission or better** on the
  repo — on public repos anyone can comment, so lower levels are ignored
  entirely (lookup cached 5 min, fails closed, needs only the mandatory
  Metadata permission). A mentioned `stop` stops the running session.
- Dedup is a persisted watermark (`<state-dir>/github-sync.json`, atomic
  write): first run records a baseline and emits nothing; after that, comments
  posted while mikan was down replay on restart, and already-handled ids never
  re-trigger. The file lives in the host-only state dir so sandboxed code
  cannot reset it.
- First contact via a comment fetches the issue title/body and logs it ahead
  of the comment so the session knows what the thread is about.
- `uploadFile` posts a pointer comment; the REST API cannot attach files.

## Repo access and pull requests

The sandbox stays credential-free; git happens on both sides of the
conversation-dir bind mount:

- First contact clones the repo shallowly into `<conversationDir>/repo/`
  using an ephemeral installation token scoped to that one repo with
  `contents:read`. The token is passed per git invocation (never written to
  `.git/config`). PR conversations get the PR head checked out under its
  real branch name (resolved via the API; fork PRs and failed lookups fall
  back to `pr-<n>`) — so a PR whose head is a `pi/*` branch can be updated
  in place: commit on it and `github_pr` pushes back to the same PR.
- The agent branches/commits inside the sandbox with plain git (bot identity
  preconfigured); push fails there by design.
- The `github_pr` tool runs host-side: it mints a `contents:write` +
  `pull_requests:write` token for that repo, pushes the agent's `pi/*` branch
  from the host side of the mount, and opens the PR (draft supported) as the
  App. Calling it again with the same branch pushes new commits to the
  existing open PR instead of failing. Default-branch pushes, force pushes,
  and merging are impossible by construction — humans review and merge.
- The `github_checks` tool (read-only, host-side) reports CI check runs for a
  pushed branch — or the PR head in PR conversations — and fetches one run's
  log tail: `job_id` for GitHub Actions, `build_id` for Cloud Build when the
  host has GCP credentials (see Configuration). Other external CI degrades to
  guidance text.
- The `github_sync` tool refreshes the `./repo` snapshot from origin (PR head,
  base branch, or a named branch) with an ephemeral `contents:read` token. It
  only moves the checkout when that provably cannot lose agent work (clean
  tree, no agent commits — force-pushed heads still sync); otherwise it is
  fetch-only and reports so the agent can merge/rebase FETCH_HEAD itself.
- The `github_review_reply` tool answers inside one inline review thread
  (`comment_id` from an `rc-<id>` message); normal responses post as plain PR
  comments.
- The `github_read` tool reads what the clone cannot show: PR metadata/diff
  stats, changed files, review state with open thread rc- ids, issue metadata,
  recent comments, and a filtered issue/PR listing. Same-repo by construction.
- The `github_issue` tool manages labels, assignees, and close/reopen on any
  issue of the conversation's repo (triage); lock/delete/transfer are not in
  the action set at all.
- Requires the App to have **Contents: Read & write**, **Checks: Read**, and
  **Actions: Read** for job logs (plus the existing Issues / Pull requests
  read & write).
- GitHub sets `MessagingInfo.trustModel: "open-trigger"`, so
  `sandbox.defaultSharedVault` is never ambient-copied (see
  `src/vault/policy.ts`). Admins can still explicitly provision a vault for
  a specific GitHub conversation.
- A missing `./repo` is re-attempted on every trigger (no-op once cloned), so
  a first clone that failed — e.g. App permissions granted later — heals on
  the next mention.
