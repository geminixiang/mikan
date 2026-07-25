---
status: accepted
---

# Remote execution is a task executor, not a sandbox runtime

A sandbox runtime is the agent's computer: it receives a workspace projection and keeps it across turns, so sessions, `MEMORY.md`, skills, and checkouts written in one turn are still there in the next. Remote execution cannot be that, because sharing a POSIX filesystem over a WAN has no working answer — we built `gondolin:remote` on NFS, live-verified it, found that even a direct 195ms link kills it, and deleted the whole control plane (`5754189`…`c32f34d`, 2026-07-24; see the workspace transport research for issue #88). So remote execution belongs to the agent as a **tool** it calls for ephemeral, parallelisable tasks, and must not be a member of `SandboxConfig`.

This is a boundary rule, not only a statement about Cloudflare: isolation is not what makes something a sandbox runtime — a persistent workspace is. A new execution surface qualifies only if it can hold a workspace projection.

## Considered Options

- **Task executor tool (chosen)** — the agent or an extension calls it with a command and env and gets stdout/stderr/exit code back. This is already the exact shape of the bridge's `/exec` payload, so the change moves an existing RPC out of a position it was forced into rather than adding an abstraction.
- **Make remote execution persist the workspace** — the `gondolin:remote` path: NFS-export the host workspace to the worker. Built, shipped, live-verified with two daemons, then deleted. Same-LAN worked; high-latency links did not, and no admission gate makes that safe enough to promise. Rejected.
- **Leave `cloudflare:*` in `SandboxConfig`** — the status quo, in which the type claims a workspace the runtime never receives. `ActorExecutionResolver` resolves mounts (`src/execution-resolver.ts:65`) and the Cloudflare branch discards them (`:99-104`); the payload has no mount concept; `credentials.fileMounts` is `false`; and `getPathContext` returns a host/runtime root pair with no translation between them. Rejected: the union membership is what invites the next mistake.

## Consequences

The trust decision in `allowsAmbientDefaultSharedVault` collapses to `image` alone, without a hand-maintained list of "isolated" sandbox types. That list is exactly how the problem propagates: `19845f7` added `agent-sandbox` to it by pattern-matching topology (isolated + per-conversation) instead of trust, and the same reasoning would wrongly pull in `gondolin`. `sandbox.defaultSharedVault` is a convenience for a trusted internal team sharing one credential set, which is `image:*` and nothing else.

`Executor` also stops having to answer `getWorkspacePath` / `getPathContext` for something with no workspace.

Implemented as the `remote_task` tool. Each call gets a throwaway `mikan-task-<uuid>` sandbox rather than a per-conversation sticky id: sticky ids would carry scratch state between calls, which is the persistence this decision rejects, and would make a conversation's parallel calls collide. The tool is registered only when `CLOUDFLARE_SANDBOX_URL` is set, so a host without a bridge never advertises it.

The task executor receives **no vault credentials**. The conversation vault belongs to the sandbox runtime; a throwaway remote task gets only what its command carries. Sending a user's credentials to a remote third party is not something to enable by default, and nothing in this decision required it.

`--sandbox=cloudflare:*` is rejected at startup with migration guidance, following the `sandbox.gondolin.remote` precedent. Nothing is lost in the move: the mode never mounted the workspace either, so no deployment's sessions or files lived on the remote side.
