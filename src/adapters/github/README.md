# src/adapters/github

GitHub adapter: one issue or PR = one conversation. Polls the GitHub API as a
GitHub App installation (no webhooks, matching mikan's proactive model — see
`DESIGN.md` for the full rationale and decisions).

## Files

- `bot.ts`: `GithubMessagingBot` — MessagingBot implementation plus the poll
  loop (incremental `since` cursors, ETag conditional requests, mention /
  participation triggering).
- `client.ts`: minimal GitHub REST client authenticated as a GitHub App
  (RS256 app JWT → cached installation tokens).
- `context.ts`: per-event `ConversationMessage` / `ConversationResponder`;
  no streaming — the finished response is posted as one comment (per-delta
  edits would churn the API and mark every reply "edited").
- `ids.ts`: `GH_<owner>_<repo>_<number>` conversation id encode/parse.
- `repo.ts`: host-side git operations — shallow clone into the conversation
  dir and guarded branch push (`pi/*` only, non-force, tokens per-invocation
  and never persisted).
- `types.ts`: adapter config, event, and GitHub REST payload types.

## Configuration (env)

- `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` — required.
- `GITHUB_APP_PRIVATE_KEY` (PEM, `\n` escapes allowed) or
  `GITHUB_APP_PRIVATE_KEY_PATH` — required, one of.
- `GITHUB_REPOS` — optional comma-separated `owner/repo` list; defaults to
  every repository the installation can access.
- `GITHUB_POLL_INTERVAL` — optional poll interval in seconds (default 60).

## Behavior notes

- Session scope: the whole issue/PR is one persistent session
  (`sessionKey === conversationId`); PR review-line threads are not mapped yet.
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
  `.git/config`). PR conversations get the PR head checked out as `pr-<n>`.
- The agent branches/commits inside the sandbox with plain git (bot identity
  preconfigured); push fails there by design.
- The `github_pr` tool runs host-side: it mints a `contents:write` +
  `pull_requests:write` token for that repo, pushes the agent's `pi/*` branch
  from the host side of the mount, and opens the PR (draft supported) as the
  App. Calling it again with the same branch pushes new commits to the
  existing open PR instead of failing. Default-branch pushes, force pushes,
  and merging are impossible by construction — humans review and merge.
- The `github_checks` tool (read-only, host-side) reports CI check runs for a
  pushed branch — or the PR head in PR conversations — and fetches one job's
  log tail (`job_id`) so the agent can diagnose failures and iterate until CI
  passes.
- Requires the App to have **Contents: Read & write**, **Checks: Read**, and
  **Actions: Read** for job logs (plus the existing Issues / Pull requests
  read & write).
- GitHub conversations are excluded from `sandbox.defaultSharedVault`: that
  ambient credential copy is a membership-trust convenience for closed
  platforms, and a GitHub conversation can be driven by any repo-write
  commenter. See `src/vault/README.md` § Identity model. Admins can still
  explicitly provision a vault for a specific GitHub conversation.
- A missing `./repo` is re-attempted on every trigger (no-op once cloned), so
  a first clone that failed — e.g. App permissions granted later — heals on
  the next mention.
