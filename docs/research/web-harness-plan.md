# Web harness plan

Status: proposal (2026-08-15). Companion to the pi 0.84 upgrade shim
(`src/harness/pi-session.ts`).

## Goal

A web frontend for mikan: a user logs in and gets a dedicated workspace to
work in, on the same runtime the IM adapters use. IM surfaces (Slack,
Telegram, Discord, GitHub) cap out at message-shaped interaction; the web
surface should show live streaming, tool calls, session history, and
eventually files/subagents.

## What already exists (reuse, don't rebuild)

- **Adapter seam**: `createConversationRuntime` + `MessagingBot` /
  `ConversationResponder` stubs — proven by `deploy/examples/embedder`
  (~120 lines of stdin/stdout adapter over the npm surface). A web adapter
  is this pattern plus HTTP.
- **Per-user isolation for free**: one web user (or user × project) → one
  `OfficeAddress` → an office with its own sessions, vault, MEMORY.md,
  skills, attachments, and sandbox container. Exactly the "dedicated
  workspace per login" requirement.
- **Web infra already in-tree** (`src/web/`): `startWebServer`, the
  session-view UI with SSE live stream and `POST /session/message` (a
  working web→agent round trip), `/api/agent-events/stream` SSE of
  `AgentEventEnvelope`, admin portal, portal token store.
- **History**: per-office `log.jsonl` + `ChatHistorySync` + the
  session-view service. Channel conversation history is already loadable
  into a web UI model — the web surface can browse IM conversations too,
  not just its own.

## Lessons taken from deepseek-harness (dsh)

dsh's client/server split is the proven minimal protocol shape:

1. **HTTP up, WebSocket/SSE down.** Commands are unary POSTs; events flow
   on a downlink-only stream. No bidirectional socket state machine.
2. **Whole-snapshot pushes for transient state** (queue, running jobs,
   subagent progress) — reconnect and multi-tab convergence become trivial,
   and matter more for mikan (Slack + web open on the same conversation).
3. **Append-only session log as truth; host-side render intents.** Durable
   events are replayed verbatim; presentation models (tool cards, diffs)
   are computed server-side and never persisted.
4. **dsh has no auth by design** (loopback trust fence only). Nothing to
   copy there — auth is mikan's own gap to fill.
5. Don't copy dsh's in-browser plugin runtime; a plain SPA over the wire
   protocol suffices since mikan extensions are host-side.

## Phases

### Phase 1 — adopt pi 0.84's v4 session model

pi 0.84 rewrote sessions: v4 JSONL, string ids, `seq` watermarks, lane
records (operations, queue, usage), compaction with inline `retainedTail`,
plus a session **search** module. That is almost exactly the append-only
log + seq-watermark wire model the dsh design calls for — so v4 adoption
and the web harness are one design problem. Doing the web surface on v3
and migrating later would mean paying for the migration twice.

- Replace `SessionStore` (v3) with pi's v4 `Session`/JSONL repo behind the
  existing store interface; write a one-time v3→v4 file migrator (the
  current `pi-session.ts` converter is the semantic spec for it).
- Delete the shim once mikan writes v4 natively.
- Adopt pi's lane/queue model to replace the "Agent is already processing"
  rejection with real steer/follow-up queueing — needed for a responsive
  web composer anyway.

### Phase 2 — web adapter + wire protocol

- Add `"web"` to `PlatformName` (`src/types.ts`, `assertPlatformName`),
  `trustModel: "membership"`.
- Web `ConversationResponder` that feeds a per-conversation event stream
  instead of message edits (skip the progressive renderer; raw deltas).
- Protocol (dsh-shaped): `POST /api/<method>` for commands
  (`session.prompt/cancel/list/history`, `workspace.*`); one downlink
  stream per client with frames = durable session events passthrough +
  whole-snapshot control frames (queue, jobs, subagent progress) +
  answerable frames (questions/approvals echoing an rpcId).
- Filter the existing agent-events broadcast per session/user (today it is
  one global SSE with one token).

### Phase 3 — auth and accounts

The genuinely new layer; nothing in-tree or in dsh provides it.

- HTTP session identity (start simple: OAuth via GitHub/Google, or
  single-tenant token login).
- Identity → conversationId mapping (`web_<userId>_<workspaceSlug>` →
  OfficeAddress); vault scoping falls out since the vault key is the
  office key.
- `ConversationEvent.user`/`userName` attribution already handles
  multi-user prompts.
- Authorization: which offices a login may see (own web offices always;
  IM offices gated on platform identity linking).

### Phase 4 — richer surface

- Channel-history browser across IM conversations (reuse
  `ChatHistorySync` + conversation-log coalescing).
- pi 0.84 session search over all offices.
- Subagent progress panes (snapshot seam from `src/subagent-progress.ts`).
- Sandbox targets: `image:*`/`gondolin:*` only, per the consolidation
  direction.

## pi adoption backlog (from the 0.84 survey, independent of the web work)

Ranked; each is "use pi instead of custom code" or an unused feature:

1. Replace the hand-rolled retry loop in `src/harness/runner.ts`
   (`RETRYABLE_ERROR_PATTERN` + backoff) with pi-ai's
   `isRetryableAssistantError`/`retryAssistantCall`/`RetryPolicy`.
2. Pass `sessionId` + `cacheRetention` through to streams — direct lever on
   prompt-cache hit rates already under observation.
3. `thinkingBudgets` wiring next to the existing thinking-level plumbing.
4. Steer/follow-up queues for mid-run user messages (also Phase 1).
5. Session search for portal/session-view.
6. Typebox skew: import `Type`/`TSchema` via pi re-exports instead of a
   separate `@sinclair/typebox` major.
7. Evaluate (not assume): pi's `loadSkills`, generic `ExecutionEnv` file
   tools over mikan's sandbox `Executor`, prompt templates, telemetry
   spans. AgentHarness itself: evaluate only — `MikanAgentSession` is a
   deliberate, extension-hooked equivalent and the lane rewrite is days
   old.
