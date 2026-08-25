# Web harness plan

Status: Phase 2 backend shipped (2026-08-16). The formal React product surface is next.

## Goal

A first-class Web adapter for mikan: a user signs in with Google or GitHub and owns one or more dedicated Web workspaces on the same runtime that IM adapters use. IM surfaces (Slack, Telegram, Discord, GitHub) remain message-shaped support surfaces; `/pi-session`, `/pi-login`, and the Admin portal remain short-lived capability interfaces for those conversations. They are not the foundation of the formal Web product.

Each browser workspace has an opaque id and maps to an independent office:

```ts
createOfficeAddress("web", workspace.id);
```

The Web account id, provider, email, and mutable workspace name are not encoded into the office identity. A Web office does not automatically share or merge sessions, memory, files, skills, vaults, or sandbox state with an IM office. Future account/IM linking must be explicit authorization and must not silently merge offices.

## What already exists (reuse, don't rebuild)

- **Shared runtime**: `ConversationRuntime`, `MessagingBot`, and `ConversationResponder` are the adapter seam. `WebMessagingBot` enters the same harness and pi loop as every IM adapter.
- **Office isolation**: one Web workspace → one `OfficeAddress` → one office with sessions, vault, memory, skills, attachments, and sandbox state.
- **Native pi v4 durability**: `SessionStore` is an async facade over pi `Session`/JSONL v4. `mikan sessions migrate` converts legacy v3 files with verified `.v3.bak` backups.
- **Host-side presentation**: `src/web/session-view/service.ts` projects durable sessions without exposing JSONL paths or filenames.
- **Web HTTP server**: account auth, workspace APIs, the scoped SSE downlink, and the older capability portals are dispatched independently by `src/web/server.ts`.

## Lessons taken from deepseek-harness (dsh)

The implemented protocol keeps dsh's useful client/server shape without copying its browser plugin model:

1. **HTTP up, SSE down.** Commands are unary requests; events flow through a workspace-scoped downlink.
2. **Whole snapshots for transient state.** Run, queue, subagent, and reconnect tool state are replaced as whole values where appropriate.
3. **Durable session log as truth.** Pi v4 history is durable; deltas and transient UI state are not a second log.
4. **Host-side render intents.** The server emits typed source data; the client owns presentation.
5. **Auth is mikan-owned.** dsh's loopback trust model is not reused for an Internet-facing product.

## Delivered phases

### Phase 1 — pi 0.84 and v4 sessions — SHIPPED 2026-08-15

`SessionStore` now wraps pi's native v4 JSONL sessions at mikan-chosen paths. The v3 runtime shim was deleted. Production migration order is:

```text
stop daemon → mikan sessions migrate → start new version
```

The migrator verifies each result and retains a `.v3.bak` backup.

### Phase 2A — durable Web accounts and OAuth — SHIPPED 2026-08-16

The host-only authority lives at `<state-dir>/web/registry.json`. It stores versioned account, provider identity, owned-workspace, login-session, and OAuth-transaction records with private atomic replacement and reload-under-lock mutation.

- GitHub identity is the immutable numeric `id`; Google identity is the non-empty OIDC `sub`.
- Email, login, display name, and avatar are profile claims only.
- Equal email addresses across providers never auto-link accounts.
- Provider access and refresh tokens are discarded after profile lookup and never enter the registry, vault, cookie, log, or pi session.
- Browser cookies carry opaque secrets; durable login and CSRF records contain hashes only.
- OAuth state is hashed, provider/PKCE/return-path bound, expiring, and atomically one-shot.
- Production callback URLs use the configured canonical `LINK_URL`. Header-derived origins and non-`Secure` cookies are allowed only for explicit loopback development.

Browser identity authorizes owned Web workspaces. It does **not** authorize vault writes: `/pi-login` keeps its separate one-time capability boundary.

### Phase 2B — workspace runtime and wire protocol — SHIPPED 2026-08-16

Authenticated APIs expose only opaque workspace and session ids:

```text
GET   /api/web/workspaces
POST  /api/web/workspaces
PATCH /api/web/workspaces/:workspaceId
GET   /api/web/workspaces/:workspaceId/sessions
GET   /api/web/workspaces/:workspaceId/history
POST  /api/web/workspaces/:workspaceId/prompt
POST  /api/web/workspaces/:workspaceId/cancel
GET   /api/web/workspaces/:workspaceId/stream
```

Every route resolves cookie → account → owned workspace before deriving an office or session path. Unknown and foreign workspaces have the same not-found response. Browser clients never submit account ids, office keys, filenames, JSONL paths, vault ids, or host/sandbox paths.

Prompt requests contain bounded `text`, an opaque `clientRequestId`, and a mode:

- `prompt` starts only while the workspace is idle.
- `followUp` enters pi's follow-up queue for the active run.
- `steer` enters pi's steering queue for the active run.

Admission returns `202` with the server `requestId` and placement. Retries are deduplicated by `(workspace, clientRequestId)` for a bounded ten-minute/256-entry window; an equal retry returns the original result, while reuse with different text or mode conflicts. Queue snapshots are server truth. Queue removal is correlated to the exact pi `AgentMessage` object and an opaque lifecycle id, not model-visible marker text.

The SSE stream is scoped to one authorized workspace. Reconnect subscribes before reading durable history, buffers live frames during bootstrap, then emits:

```text
stream.ready (process generation UUID)
workspace.snapshot
session.snapshot (durable pi history)
run.snapshot
queue.snapshot
subagents.snapshot
running tool snapshots
buffered live frames
live frames
```

The generation UUID tells a client to discard transient state retained across a daemon restart. Live frames include response deltas/finals, authoritative pi tool ids, diagnostics, and errors. The existing global `/api/agent-events/stream` is not used by authenticated Web clients.

Scheduled/proactive Web delivery is intentionally unsupported for now because it has no authenticated-account dispatch context. Text-only `followUp` and `steer` messages reuse the active run's prepared environment rather than rerunning first-turn preparation hooks.

## Next phase — formal React application

Build a new React product surface rather than expanding the legacy portals:

1. Google/GitHub login, callback, and error states.
2. Workspace list, create, and rename.
3. Durable conversation/session history.
4. Assistant streaming and basic tool activity.
5. Composer modes, queue state, cancel, and logout.

Cross-IM history, explicit identity linking, rich file browsing, search, and advanced subagent panes remain later work.

## pi adoption backlog (independent of the Web product)

1. Replace the hand-rolled retry loop in `src/harness/runner.ts` with pi-ai retry primitives where semantics match.
2. Pass `sessionId` and `cacheRetention` through direct provider streams.
3. Wire `thinkingBudgets` next to thinking-level configuration.
4. Add pi session search to formal Web and capability views.
5. Import TypeBox through pi re-exports to remove version skew.
6. Continue evaluating—not assuming—pi skills, execution environments, prompt templates, and telemetry. `MikanAgentSession` remains deliberate extension-hooked infrastructure.
