# GitHub as a messaging adapter (design)

Status: **implemented**. See `README.md` for configuration and behavior and
[ADR 0015](../../../docs/adr/0015-github-agent-account-and-webhooks.md) for the
identity and event-source decision.

## Core assumption

**One PR or one issue = one conversation.** A GitHub issue/PR thread is
structurally the same as a Slack thread: an ordered series of comments
between participants, with reactions, that the agent can read and reply into.
So mikan's existing conversation → session → agent machinery applies with no
new concepts — only a new `MessagingBot` implementation and an event source.

## Identity: a bound agent account

mikan acts on GitHub as a regular user account the operator binds with a
fine-grained PAT (`GITHUB_AGENT_TOKEN`). An App's `slug[bot]` never appears in
@-mention autocomplete and cannot be assigned or asked for review; a user
account can, so people address mikan like a teammate. Every API call, clone,
push, and commit uses that one identity. The account is a `User`, so the
adapter ignores its own actions explicitly; the `Bot` sender check alone
would let it answer itself forever.

## Event source: best-effort webhooks

Signed webhook deliveries to the link server's `/github/webhook` are the only
event source. Polling was removed: it cost about four requests per repository
per tick and could not cover an organization with hundreds of repositories.

Delivery is best effort by decision. A person who addressed the agent notices
when it does not answer and mentions it again, which costs less than journals,
replay, and watermarks. The receiver answers 202 before any processing (GitHub
times out after 10 seconds), drops repeated delivery GUIDs from a bounded
in-memory set, and persists nothing about deliveries.

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
`GITHUB_REPOS` env var and webhook payloads), so unlike Slack's platform-issued
ids this is a mikan-derived slug. Lowercasing ensures one issue cannot split
into two conversation identities on case-sensitive filesystems.

The separator is `_`, not the `gh:<owner>/<repo>#<number>` spelling this
design first proposed: ids are used verbatim as a single path segment, so `/`
is out, and conversation dirs are bind-mounted with docker's `-v source:target`
syntax in image mode, so `:` is out too. `-` is out for a subtler reason:
owners and repos may both contain `-`, so `GH-foo-bar-baz-42` cannot be parsed
back to a unique (owner, repo) — two real repos would collide onto one
conversation. `_` is unambiguous under GitHub's name grammar: owners never
contain `_` and the trailing number is pure digits, so the first `_` and the
last `_` are always the real boundaries even when the repo name itself
contains `_` (see `parseGithubConversationId` in `src/office/index.ts`).

### Conversation directory

`GH_owner_repo_123` is already a filesystem-safe single path segment and is
used verbatim as the conversation dir, like every other platform id. One
issue/PR → one session tree → one agent memory, exactly like a Slack channel.
Re-opening the same PR later resumes its session.

## Triggering

`activity.ts` normalizes a payload into one `GithubActivity`; `bot.ts` decides.
An activity triggers when all of these hold:

1. The sender is neither a `Bot` nor the agent account.
2. The repository matches `GITHUB_REPOS`, and is private unless
   `GITHUB_PUBLIC_REPOS` is on.
3. It is one of the enabled `GITHUB_TRIGGERS`: a mention in a new issue, PR,
   comment, or review comment; an assignment to the agent; a review request
   for the agent; or any new comment in a thread that already has a
   conversation log (`followup`).
4. The sender is in `GITHUB_USERS` when that list is set.
5. The sender holds `GITHUB_MIN_PERMISSION` (write by default) on the
   repository. The lookup is cached for five minutes and fails closed.

Opening an issue that both mentions and is assigned to the agent sends two
deliveries; body-level triggers for one conversation are claimed once per ten
minutes so the agent answers once.

## Capabilities

Commenting, reading, CI results, syncing the clone, and review replies are
always available. `GITHUB_CAPABILITIES` adds `triage` (`github_issue`) and
`push` (`github_pr`). A capability that is off removes the tool from the
agent's tool list and from the conversation guide, so the model is never told
about an action it cannot take. The token's permissions and the account's
repository role remain the outer bound.

## Review threads

One PR = one flat session. Inline review comments arrive as
`pull_request_review_comment` deliveries and are injected into the PR
conversation as messages carrying file:line, the diff hunk, and the thread's
earlier turns, with an `rc-<id>` ts in their own id space. The agent answers a
specific thread with `github_review_reply`. A review whose summary body alone
mentions the agent does not trigger; review requests and inline comments do.

## Tool pack

One tool per file under `tools/`: `github_pr`, `github_checks` (Actions jobs,
commit statuses, and Actions job logs), `github_review_reply`, `github_sync`
(work-preserving clone refresh), `github_read` (metadata the clone lacks), and
`github_issue` (labels, assignees, state; closed action set). All run
host-side, are wired per run through `PlatformGithubOps`, and are enabled only
in GitHub conversations.

## Out of scope

- Guaranteed delivery and replay of missed webhooks.
- Cross-platform identity mapping (Slack↔GitHub↔Member).
- How a thread maps to an office (one office per thread today).
