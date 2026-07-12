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
  `log.jsonl`). A mentioned `stop` stops the running session.
- Dedup is a persisted watermark (`<state-dir>/github-sync.json`, atomic
  write): first run records a baseline and emits nothing; after that, comments
  posted while mikan was down replay on restart, and already-handled ids never
  re-trigger. The file lives in the host-only state dir so sandboxed code
  cannot reset it.
- First contact via a comment fetches the issue title/body and logs it ahead
  of the comment so the session knows what the thread is about.
- `uploadFile` posts a pointer comment; the REST API cannot attach files.
