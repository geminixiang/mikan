---
status: accepted
---

# Persistent offices and ephemeral factory floors are different execution products

A conversation's default execution environment is a persistent, single-node office runtime: one durable workspace, strong environment isolation, and continuity across turns and runtime restarts. Managed `image:*`, local Gondolin, and a future correctly provisioned Firecracker path fit this role. Elastic remote sandboxes instead form a factory floor for temporary, repetitive, outsourced, and highly parallel Subagent work. Factory jobs receive explicitly packaged inputs and capabilities, return explicit results, and discard both environment and local data after completion; they are not selectable as a conversation's default office.

## Considered Options

- **Separate persistent offices from ephemeral factory floors (chosen)** — each interface uses the infrastructure's natural properties: local durable storage and bounded coworkers for continuous conversation work; disposable remote capacity for elastic fan-out.
- **Make every sandbox backend a selectable conversation runtime** — rejected because Kubernetes Agent Sandbox, Cloud Run sandbox, Cloudflare Sandbox, and E2B do not naturally provide the durable workspace contract a conversation office requires. Pretending they do pushes workspace synchronization, migration, and partial-failure complexity into every turn.
- **Make remote elastic sandboxes the default office** — rejected because a conversation's working state would need continual upload, download, conflict handling, and recovery. This weakens both reliability and the office abstraction.
- **Scale persistent offices across nodes immediately** — rejected for now. Moving live offices requires distributed communication routing, durable data transport, ownership transfer, and split-brain prevention. A single-node contract is honest and sufficient for current deployments.

## Consequences

- A Default office runtime must preserve its authorized Workspace projection across turns. It is single-node by contract until mikan explicitly designs office migration.
- Subagents inside a Default office are bounded coworkers invited into the office; their concurrency is deliberately limited by local capacity.
- Future factory adapters are used by Subagents when work benefits from large fan-out. They do not receive an implicit live Workspace projection, office vault, runtime handle, or durable local directory.
- Every factory job needs an explicit input package, capability/credential grant, deadline and budget, result contract, and teardown. Durable outputs must be returned to the office or a host control plane before teardown.
- Communication between the office and factory is message/result transport, not shared POSIX storage. This avoids turning WAN filesystem synchronization into a hidden requirement.
- Cloudflare Sandbox belongs on the future Factory floor rather than in `SandboxConfig`; this reinforces ADR 0002. Kubernetes Agent Sandbox, Cloud Run sandbox, and E2B should enter through the same future factory seam rather than adding backend-specific branches to conversation runtime planning.
- This decision records direction only. The current office-isolation refactor must not implement Factory floor execution prematurely.
