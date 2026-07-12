---
title: GitHub adapter
description: GitHub App polling, issue/PR conversations, watermark dedup, and comment-based responses for the GitHub adapter.
---

One GitHub issue or pull request is one mikan conversation. The adapter polls the GitHub API as a GitHub App installation — no webhook endpoint, preserving mikan's proactive model.

## Main code

| File                             | Purpose                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/adapters/github/bot.ts`     | GitHub bot core: poll loop, watermark dedup, mention/participation triggering, comments.                     |
| `src/adapters/github/client.ts`  | Minimal REST client authenticated as a GitHub App (RS256 JWT → installation tokens).                         |
| `src/adapters/github/context.ts` | Creates the GitHub `ConversationResponder`; posts the finished response as one comment (no streaming edits). |
| `src/adapters/github/ids.ts`     | `GH_<owner>_<repo>_<number>` conversation id encode/parse.                                                   |
| `src/adapters/github/types.ts`   | GitHub adapter-specific types and REST payload shapes.                                                       |

## Configuration

| Env var                                                  | Purpose                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GITHUB_APP_ID`                                          | GitHub App id (required).                                                              |
| `GITHUB_INSTALLATION_ID`                                 | Installation id to act as (required).                                                  |
| `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_PRIVATE_KEY_PATH` | App private key PEM, inline (with `\n` escapes) or as a file.                          |
| `GITHUB_REPOS`                                           | Optional comma-separated `owner/repo` list; defaults to all installation repositories. |
| `GITHUB_POLL_INTERVAL`                                   | Optional poll interval in seconds (default 60).                                        |

## Event source

A poll loop fetches, per watched repo, issues and issue/PR comments updated since an incremental cursor, using ETag conditional requests (304 responses are free against the rate limit). Dedup is a persisted watermark at `<state-dir>/github-sync.json` (atomic write):

- The first run records a baseline and emits nothing — history never triggers.
- Already-handled comment/issue ids never re-trigger, and edits do not re-trigger.
- Comments posted while mikan was down replay after restart.

## Triggering

A comment (or new issue body) triggers a run only when it @mentions the app slug, or the bot already participates in that issue's conversation. Everything else is ignored without creating any state. A mentioned `stop` comment stops the running session.

## Sessions and replies

The whole issue/PR is one persistent session (`sessionKey === conversationId`); PR review-line threads are not yet mapped to sub-sessions. Responses are GitHub Flavored Markdown, posted as a single comment when the response is finished — no streaming edits, so replies don't churn the API or show as "edited"; long output splits into continuation comments. The system prompt tells the agent which issue/PR the conversation is (owner/repo#number). First contact through a comment logs the issue title/body ahead of it so the session knows what the thread is about.

## Limitations

- File uploads are not supported by the REST API; `uploadFile` posts a pointer comment instead.
- PR review threads (diff-line comments) are planned but not yet polled.
