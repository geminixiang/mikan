---
title: Kubernetes SIG Agent Sandbox research
description: Upstream architecture review and lessons for mikan's distributed Gondolin sandbox.
---

# Kubernetes SIG Agent Sandbox research

> Reviewed upstream commit [`53204216685f19381cd1062a12323aa1ad7a5cf6`](https://github.com/kubernetes-sigs/agent-sandbox/tree/53204216685f19381cd1062a12323aa1ad7a5cf6) on 2026-07-20. This note uses upstream source and first-party documentation only.

## Executive summary

[`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox) is a Kubernetes-native control plane for one long-lived, stateful, singleton Pod per sandbox. Its useful abstraction is not a new VM runtime or a cross-WAN filesystem: it reconciles a `Sandbox` CR into ordinary Kubernetes Pods, optional PVCs, and an optional headless Service, with `SandboxClaim`, `SandboxTemplate`, and `SandboxWarmPool` extensions layered above it.

For mikan:

- It is a strong reference for **declarative lifecycle**, **ownership-aware adoption**, **warm-pool claims**, **status conditions**, **secure-default network policy**, and a **separate stateless data-plane router**.
- It does **not** solve Gondolin's hardest open problem: workspace durability across WAN. Storage semantics are delegated to the Kubernetes PVC/storage class.
- It also does not expose Gondolin-style lease epochs or storage-writer fencing. Kubernetes ownership and Pod reconciliation protect object identity, while storage attachment semantics are delegated to Kubernetes/CSI.
- It should not replace `image:*` or the current host-managed Gondolin fleet by default. A future **Kubernetes provider/backend** is more plausible than importing Kubernetes concepts into every Gondolin deployment.

## Architecture and lifecycle

The core `Sandbox` API embeds a complete Pod template, optional immutable volume-claim templates, lifecycle shutdown fields, and `Running`/`Suspended` operating modes. Status reports conditions, Pod IPs, node name, and optional Service identity:

- [`api/v1beta1/sandbox_types.go`](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/api/v1beta1/sandbox_types.go)
- [generated API reference](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/docs/api.md)

The controller follows a normal Kubernetes desired-state loop. It creates or adopts one Pod, records the concrete Pod name on the `Sandbox`, creates/adopts an optional headless Service, and updates observed-generation status conditions. Adoption is guarded by controller UID plus explicit adoptable/tracking labels; resources owned by another controller are rejected rather than stolen. Suspension deletes the Pod and clears its tracked name while retaining the `Sandbox` and PVCs:

- [`controllers/sandbox_controller.go`](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/controllers/sandbox_controller.go)
- [PVC suspend/resume example](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/examples/mcp-server-sandbox/README.md)

`SandboxTemplate`, `SandboxClaim`, and `SandboxWarmPool` add policy-controlled late binding and pre-warmed capacity. Claim adoption transfers Kubernetes ownership from a warm pool to one claim and verifies candidate labels, owner UID, pool identity, readiness, and exclusivity:

- [`extensions/controllers/sandboxclaim_controller.go`](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/extensions/controllers/sandboxclaim_controller.go)
- [`extensions/controllers/sandboxwarmpool_controller.go`](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/extensions/controllers/sandboxwarmpool_controller.go)

Placement itself is standard Kubernetes scheduling through the embedded `PodSpec`: node selectors, affinity, tolerations, topology constraints, runtime classes, and CSI capabilities remain Kubernetes concerns. Agent Sandbox records the selected node but does not implement an independent placement algorithm.

## Networking and trust boundaries

A Sandbox can receive a headless Service and stable cluster DNS name. The separate sandbox router maps validated `X-Sandbox-*` headers to Pod IP cache or `<sandbox>.<namespace>.svc.<cluster-domain>`, supports HTTP upgrades, retries only dial-class failures, evicts stale cached Pod IPs, and exposes Prometheus/OpenTelemetry signals:

- [`sandbox-router/README.md`](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/sandbox-router/README.md)
- [Go SDK connectivity modes](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/clients/go/README.md)

Notable router details worth copying:

- strict DNS-label, port, and target-IP validation to prevent DNS injection and metadata/loopback SSRF;
- stripping caller `Authorization` before forwarding it into an untrusted sandbox;
- bounded body sizes, request timeouts, dial-only retries, graceful drain, TLS/mTLS, metrics, and tracing;
- cache readiness only after the initial Kubernetes LIST, plus active stale-IP eviction.

The extension controller's managed default `NetworkPolicy` allows ingress only from the sandbox router and egress only to public IPv4/IPv6 ranges, excluding RFC1918, link-local, metadata, and internal DNS. Operators can supply restricted custom rules or explicitly opt out:

- [`extensions/api/v1beta1/sandboxtemplate_types.go`](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/extensions/api/v1beta1/sandboxtemplate_types.go)
- [`extensions/controllers/sandboxtemplate_controller.go`](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/extensions/controllers/sandboxtemplate_controller.go)

Important limitation: the router documentation states that its default authorizer is `AllowAll`. TokenReview mode authenticates a Kubernetes principal but currently does not authorize that principal against the requested individual Sandbox. Per-sandbox authorization, rate limiting, circuit breaking, WAF, and advanced load balancing remain follow-up or edge-proxy responsibilities.

## Workspace and persistence

Persistence is PVC-based. `volumeClaimTemplates` are immutable on a Sandbox and create per-sandbox PVCs; `Suspended` removes compute while preserving those PVCs for a fresh Pod on resume. Examples primarily use `ReadWriteOnce`; one late-bound storage example uses a regional `ReadWriteMany` storage class:

- [`SandboxBlueprint.VolumeClaimTemplates`](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/api/v1beta1/sandbox_types.go)
- [MCP server RWO persistence example](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/examples/mcp-server-sandbox/sandbox.yaml)
- [late-bound regional RWX example](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/examples/latebind-storage-gke-sandbox/storage-infra.yaml)

This is deliberately a storage-provider contract, not a workspace synchronization protocol. The project does not define snapshot generations, content-addressed commits, conflict handling, WAN transfer, or application-level write fencing. RWO attachment and CSI behavior can provide a useful single-writer boundary inside one Kubernetes storage domain, but that is not evidence for safe cross-WAN mutable workspaces.

## Fencing and failure recovery

Agent Sandbox relies on Kubernetes API resource versions, owner references/UIDs, controller reconciliation, scheduler placement, Pod termination, and CSI attachment semantics. It detects and logs multiple Pods for one Sandbox and carefully refuses adoption/deletion when ownership does not match, but the public API contains no lease epoch or explicit fencing token that a workspace backend must validate.

This differs from Gondolin:

- Gondolin's daemon lease epoch and host-side durable watermark explicitly fence a potentially partitioned old runtime before failover.
- Agent Sandbox delegates singleton execution and volume attachment to Kubernetes. It does not offer an independent proof that an old process has stopped writing to an external/shared filesystem.

Its recovery model is nevertheless useful at the control-plane level: deterministic reconciliation, observed-generation conditions, durable CR/PVC state, explicit suspended state, idempotent ownership-aware adoption, and SDK cleanup/reconnect behavior. The Go SDK preserves failed-cleanup claim identity, reports orphaned claims, bounds each readiness phase, and marks dead port-forward transports not-ready instead of waiting for operation timeouts:

- [`clients/go/README.md`](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/clients/go/README.md)

## Maturity

The repository currently publishes `v0.x` releases (latest observed tag: `v0.5.2`) and stores both `v1alpha1` and `v1beta1` CRDs. Its 2026 roadmap says portable runtime/backend decoupling, rolling updates, first-class router support, auto suspend/resume, stronger security posture, multi-cluster federation, and production-ready reference architectures are still in progress or planned:

- [release tags](https://github.com/kubernetes-sigs/agent-sandbox/tags)
- [`roadmap.md`](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/roadmap.md)
- [`RELEASE.md`](https://github.com/kubernetes-sigs/agent-sandbox/blob/53204216685f19381cd1062a12323aa1ad7a5cf6/RELEASE.md)

It is active and substantial, but its own roadmap does not yet claim a finished multi-cluster, runtime-portable production architecture.

## Recommendations for mikan

### Adopt now

1. **Separate lifecycle from transport.** Preserve Gondolin's fleet/lease owner as control plane and keep command tunnels as a data plane, like Sandbox CR/controller versus router.
2. **Desired/observed generation status.** Add explicit desired runtime generation and observed worker generation when Gondolin eventually gains a workspace-generation backend; do not add a marker before a producer and CAS contract exist.
3. **Ownership-aware adoption.** Continue requiring stable runtime/session identity and reject ambiguous adoption. Agent Sandbox's UID plus explicit adoptability label is a useful model for future warm pools.
4. **Secure-default network policy vocabulary.** Gondolin has the necessary programmable HTTP hooks and denies unmapped raw TCP/SSH, but mikan should add an explicit egress policy surface before changing existing internal HTTP(S) reachability. The secure profile should deny internal/link-local/metadata destinations by default and require reviewed exceptions.
5. **Router hardening patterns.** Copy dial-only retry rules, stale-target invalidation, readiness-after-initial-sync, SSRF-safe target validation, authorization-header stripping, graceful drain, and per-reason metrics.
6. **Suspend/resume semantics.** Treat compute lifecycle and durable workspace lifecycle as separate state machines.

### Do not infer or copy blindly

1. Do not treat PVC support as a cross-WAN workspace design.
2. Do not replace Gondolin's lease epochs/fencing with "Kubernetes runs one Pod" when external mutable storage is involved.
3. Do not expose a header-selected sandbox router with `AllowAll`; mikan's conversation/user identity must authorize the exact sandbox target.
4. Do not require Kubernetes for `image:*` or small Gondolin deployments; it would replace a compact worker protocol with a large operational dependency.
5. Do not claim multi-cluster support based on the current project roadmap.

### Plausible integration boundary

If mikan needs a Kubernetes deployment tier, implement a separate `gondolin:kubernetes` provider (or a generic future remote provider) that maps a mikan conversation to a `SandboxClaim`/`Sandbox`, uses a PVC-backed workspace where the cluster storage contract is acceptable, and routes through an authenticated per-sandbox gateway. Keep `gondolin:remote` for host-managed microVM workers and its explicit lease fencing. The two backends can share high-level lifecycle/status vocabulary without pretending their storage and isolation guarantees are identical.
