# src/adapters/github

GitHub adapter: one issue or PR = one conversation. mikan acts as a bound
GitHub user account and is driven by signed webhooks (see `DESIGN.md` and
[ADR 0015](../../../docs/adr/0015-github-agent-account-and-webhooks.md)).

## Configuration (env)

Required:

- `GITHUB_AGENT_TOKEN` — fine-grained PAT of the agent account with Contents,
  Issues, and Pull requests read & write, and Actions and Commit statuses read.
  Startup fails when `GET /user` rejects it.
- `GITHUB_WEBHOOK_SECRET` — secret of an organization or App webhook that
  delivers Issues, Issue comments, Pull requests, and Pull request review
  comments to `<LINK_URL>/github/webhook`. The link server must run
  (`LINK_PORT`); startup fails otherwise.
- `GITHUB_REPOS` — comma-separated `owner/repo` or `owner/*`. Nothing else is
  answered.

Restrictions (optional):

- `GITHUB_PUBLIC_REPOS=true` — also answer in public repositories.
- `GITHUB_USERS` — only these logins can trigger.
- `GITHUB_MIN_PERMISSION` — `write` (default), `maintain`, or `admin`.
- `GITHUB_TRIGGERS` — any of `mention`, `assign`, `review`, `followup`
  (default all).
- `GITHUB_CAPABILITIES` — `triage` and/or `push` (default none: the agent can
  comment and read but not change labels, assignees, or code).

`policy.ts` parses and applies these; an unknown value fails startup.

## Behavior notes

- Session scope: the whole issue/PR is one persistent session
  (`sessionKey === conversationId`).
- Delivery is best effort: nothing about deliveries is persisted, repeated
  GUIDs are dropped in memory, and events sent while mikan is down are lost.
- First contact via a comment fetches the issue title/body and logs it ahead
  of the comment so the session knows what the thread is about. Assignments
  and review requests use the title and body from the payload.
- A mentioned `stop` (or `/stop`) stops the running session; the magic word
  is recognized by conversation intake with one grammar across platforms.
- `uploadFile` posts a pointer comment; the REST API cannot attach files.
- There is no streaming: the finished response is posted as one comment,
  because per-delta edits would churn the API and mark every reply "edited".
- The `github_*` tools are a `PlatformToolPack` injected from `main.ts`, not
  core tools; the pack omits tools whose capability is off.
- GitHub sets `MessagingInfo.trustModel: "membership"`: only collaborators
  with at least write access trigger it (`GITHUB_MIN_PERMISSION` accepts
  nothing lower), so `sandbox.defaultSharedVault` and settings-declared MCP
  servers apply as on Slack.

## Repo access and pull requests

The host never runs git (ADR 0016; guard `github-adapter-runs-no-host-processes`).
The agent clones, commits, and pushes inside its sandbox with the sandbox's
GitHub credentials (the Vault, usually through `sandbox.defaultSharedVault`).
What it can push is decided by that token, the account's repository role, and
branch protection, not by mikan. The prompt gives the agent account as the
commit identity (`<id>+<login>@users.noreply.github.com`).

- `github_pr` (capability `push`) opens a pull request for a branch the agent
  already pushed, or returns the open PR for that branch. It never pushes.
- `github_checks` reports GitHub Actions jobs and commit statuses for a
  pushed branch or the PR head, and fetches one Actions job's log tail by
  `job_id`. Fine-grained PATs have no Checks permission, so check runs from
  third-party CI apps are not visible.
- `github_review_reply` answers inside one inline review thread.
- `github_read` reads PR metadata, changed files, reviews, issues, and
  comments of the conversation's repository.
- `github_issue` (capability `triage`) manages labels, assignees, and
  close/reopen; lock, delete, and transfer are not in the action set.
