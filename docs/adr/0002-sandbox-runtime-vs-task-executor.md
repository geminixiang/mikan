---
status: proposed
---

# Remote execution is a task executor, not a sandbox runtime

A sandbox runtime is the agent's computer: it receives a workspace projection and keeps it across turns, so sessions, `MEMORY.md`, skills, and checkouts written in one turn are still there in the next. Remote execution cannot be that, because sharing a POSIX filesystem over a WAN has no working answer — we built `gondolin:remote` on NFS, live-verified it, found that even a direct 195ms link kills it, and deleted the whole control plane (`5754189`…`c32f34d`, 2026-07-24; see the workspace transport research for issue #88). So remote execution belongs to the agent as a **tool** it calls for ephemeral, parallelisable tasks, and must not be a member of `SandboxConfig`.

This is a boundary rule, not only a statement about Cloudflare: isolation is not what makes something a sandbox runtime — a persistent workspace is. A new execution surface qualifies only if it can hold a workspace projection.

## Considered Options

- **Task executor tool (chosen)** — the agent calls it with a command and env and gets stdout/stderr/exit code back. This is already the exact shape of the bridge's `/exec` payload, so the change moves an existing RPC out of a position it was forced into rather than adding an abstraction.
- **Make remote execution persist the workspace** — the `gondolin:remote` path: NFS-export the host workspace to the worker. Built, shipped, live-verified with two daemons, then deleted. Same-LAN worked; high-latency links did not, and no admission gate makes that safe enough to promise. Rejected.
- **Leave `cloudflare:*` in `SandboxConfig`** — the status quo, in which the type claims a workspace the runtime never receives. `ActorExecutionResolver` resolves mounts (`src/execution-resolver.ts:65`) and the Cloudflare branch discards them (`:99-104`); the payload has no mount concept; `credentials.fileMounts` is `false`; and `getPathContext` returns a host/runtime root pair with no translation between them. Rejected: the union membership is what invites the next mistake.

## Consequences

The trust decision in `allowsAmbientDefaultSharedVault` collapses to `image` alone, without a hand-maintained list of "isolated" sandbox types. That list is exactly how the problem propagates: `19845f7` added `agent-sandbox` to it by pattern-matching topology (isolated + per-conversation) instead of trust, and the same reasoning would wrongly pull in `gondolin`. `sandbox.defaultSharedVault` is a convenience for a trusted internal team sharing one credential set, which is `image:*` and nothing else.

`Executor` also stops having to answer `getWorkspacePath` / `getPathContext` for something with no workspace.

Not yet implemented. Two questions block it, and neither is answerable from the code: whether a task executor call gets a throwaway sandbox id (true parallelism, cold start each time) or keeps today's per-conversation sticky id (scratch state across calls, which reintroduces the persistence problem this decision rejects), and whether any deployment currently runs `--sandbox=cloudflare:*` and would fail at startup.
