# GitHub as a messaging adapter (design)

Status: **implemented** (issue/PR conversation comments and inline PR review
comments — see `README.md` for configuration and behavior). A fourth platform
adapter beside Slack / Discord / Telegram, living in `src/adapters/github/`.

## Core assumption

**One PR or one issue = one conversation.** A GitHub issue/PR thread is
structurally the same as a Slack thread: an ordered series of comments
between participants, with reactions, that the bot can read and reply into.
So mikan's existing conversation → session → agent machinery applies with no
new concepts — only a new `MessagingBot` implementation and an event source.

## Why this shape (and not webhooks)

mikan is a **proactive** runtime: adapters connect out (Slack socket mode)
and push events in; the agent is triggered by messages and schedules, not by
inbound HTTP. A GitHub adapter therefore **polls** the GitHub API (like
socket mode connects out) rather than exposing a webhook endpoint. Same
adapter contract, no new inbound-HTTP surface, no break in the model.

## Identity mapping

| mikan concept        | GitHub                                                               |
| -------------------- | -------------------------------------------------------------------- |
| conversation         | one issue or one PR                                                  |
| `conversationId`     | `GH_<owner>_<repo>_<number>` (verbatim, stable)                      |
| conversation message | an issue/PR comment, an inline review comment, or the issue/PR body  |
| message `ts`         | the comment id; `rc-<id>` for review comments (own id space)         |
| thread               | a PR **review thread** — flattened into the PR session (see Decided) |
| `postMessage`        | create an issue/PR comment                                           |
| `addReaction`        | add a reaction to a comment (GitHub has reactions)                   |
| user                 | GitHub login                                                         |
| `conversationKind`   | always `shared` (issues/PRs are public within repo)                  |

`conversationId` uses the `GH_` prefix so it never collides with Slack
(`C…`/`D…`) or other platforms. Owner and repo are **lowercased**: GitHub
names are case-insensitive, and the id has two spelling sources (the
`GITHUB_REPOS` env var and API payloads), so unlike Slack's platform-issued
ids this is a mikan-derived slug — and LAYOUT.md § Casing lowercases derived
slugs so one issue can never split into two conversation dirs on
case-sensitive filesystems.

The separator is `_`, not the `gh:<owner>/<repo>#<number>` spelling this
design first proposed: ids are used verbatim as a single path segment, so `/`
is out, and conversation dirs are bind-mounted with docker's `-v source:target`
syntax in image mode, so `:` is out too. `-` is out for a subtler reason:
owners and repos may both contain `-`, so `GH-foo-bar-baz-42` cannot be parsed
back to a unique (owner, repo) — two real repos would collide onto one
conversation. `_` is unambiguous under GitHub's name grammar: owners never
contain `_` and the trailing number is pure digits, so the first `_` and the
last `_` are always the real boundaries even when the repo name itself
contains `_` (see `ids.ts`).

### Conversation directory

`GH_owner_repo_123` is already a filesystem-safe single path segment and is
used verbatim as the conversation dir, like every other platform id. One
issue/PR → one session tree → one agent memory, exactly like a Slack channel.
Re-opening the same PR later resumes its session.

## Event source (polling)

A poller tracks, per watched repo, the issues/PRs and their comments. New
comments → `enqueueEvent` with the conversation = that issue/PR. Poll
interval is a config knob. No webhook, no inbound port.

**Dedup via a watermark, not a time cursor** (pattern borrowed from
hermes-agent's watchers, which are the closest prior art and also poll-first):
keep a bounded set of already-seen comment ids per watched feed, persisted
with an atomic write (`.tmp` → rename, so a crash can't corrupt dedup state).
This avoids the boundary races of a `since` timestamp. **First run records
the baseline and emits nothing** — otherwise the first poll would trigger a
run on every historical comment in the repo. Subsequent runs emit only ids
not in the set.

Prior art note: nousresearch/hermes-agent polls GitHub via cron watchers
(webhook optional, for those with a public endpoint) — validating the
polling choice. openclaw has ~100 platform extensions but does NOT model
GitHub as a chat platform (it uses `gh` as a tool), confirming that
"GitHub = conversation" is a deliberate, uncommon abstraction — mikan's
differentiator (an agent that lives in a PR with session + memory), not an
oversight.

Open question: which repos/issues to watch — all issues in configured repos,
or only threads where the bot is @mentioned or already participating? Start
narrow: **only threads the bot is mentioned in or has commented on**, to
avoid triggering on every comment in a busy repo.

## Triggering

Like Slack: not every comment triggers a run. Default trigger = the bot is
**@mentioned** in a comment, or the comment is in a thread the bot already
participates in. Auto-reply rules (the existing mechanism) can widen this per
repo/thread later.

## What this removes from agent-pm

agent-pm's `github_monitor` (~2637 lines: GitHub API client, User/Repo/Issue/
PR/Commit models, SyncRun/SyncCheckpoint, daily activity sync) exists largely
to pull GitHub activity into a database. With a GitHub adapter, that activity
arrives as mikan conversations/messages, and agent-pm keeps only the parts
that are genuinely its business — computing metrics and deciding what to say —
on top of sqlite (`api.paths.dataDir`), not a Django ORM. The adapter absorbs
the sync/schema/client boilerplate; agent-pm shrinks toward its ~2000-line
business core.

## Fallback: GitHub as a tool, not only a conversation

The conversation abstraction is the ambitious path (session + memory in a
PR). A lighter path always remains available and complementary: the agent
can drive GitHub with the `gh` CLI as a plain tool inside the sandbox (how
hermes-agent does it — cron + skill + `gh`), with no adapter involved. The
adapter is for _inhabiting_ a thread; `gh`-as-a-tool is for one-shot actions.
Both can coexist.

## Explicitly out of scope

- Cross-platform identity mapping (Slack↔GitHub↔Member) — that is agent-pm's
  business model, not a platform capability.
- A GitHub REST/webhook server — polling only, proactive model preserved.
- An ORM / Postgres layer — extensions use sqlite via `api.paths`.

## Decided

- **Polling, not webhooks** (proactive model preserved).
- **Narrow trigger: @mention** (or a thread the bot already participates in).
- **Auth: GitHub App**, not a PAT. An App gives a per-installation token with
  a much higher rate-limit budget (scales with installed repos), fine-grained
  per-repo permissions, an identity of its own (comments come from the app,
  not a human's account), and reactions/comment scopes. Config: App id +
  private key + installation id; the adapter mints short-lived installation
  tokens and refreshes them. `bot` identity in `MessagingInfo` = the app's
  bot user (`<app-name>[bot]`).
- **Review threads: one PR = one flat session.** Inline review comments are
  polled from `/pulls/comments` (same watermark discipline, own id space →
  `rc-<id>` ts) and injected into the PR conversation as messages carrying
  file:line, the diff hunk, and the thread's earlier turns. No sub-sessions:
  the agent keeps the full PR context and answers a specific thread with the
  `github_review_reply` tool. Known limitation: a review whose summary body
  alone mentions the bot (zero inline comments) does not trigger — there is
  no repo-wide "reviews since" endpoint and per-PR fan-out is not worth it.
- **Tool pack, one tool per file under `tools/`**: `github_pr`,
  `github_checks` (Actions job logs + Cloud Build logs via host-side GCP ADC
  when configured), `github_review_reply`, `github_sync` (work-preserving
  clone refresh), `github_read` (metadata the clone lacks), `github_issue`
  (labels/assignees/state; closed action set). All host-side, wired per run
  through `PlatformGithubOps`, enabled only for github conversations.

## Open questions for implementation

1. Rate limits: polling budget, `since` cursors, conditional requests
   (ETag/If-Modified-Since) to stay under the limit on busy repos. The App's
   higher budget helps but polling still needs to be incremental. (Current:
   3 conditional requests per repo per tick; 304s are free.)
2. Message shape: how much of a comment (body, diff hunk, review state) maps
   into `ConversationMessage`, and how the agent's reply renders (Markdown is
   native to GitHub, so no Block Kit translation needed).
