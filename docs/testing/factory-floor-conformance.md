# Factory floor provider conformance

This document defines the future verification contract for ephemeral Factory floor providers described by [ADR 0004](../adr/0004-persistent-offices-and-ephemeral-factory-floors.md). It records direction only; mikan does not yet implement Factory jobs.

## Core contract

A Factory job is disposable work, not a remote Conversation office:

```ts
interface FactoryJob {
  jobId: string;
  idempotencyKey: string;
  inputPackage: { digest: string; manifest: PackageManifest };
  grants: CredentialGrant[];
  network: NetworkPolicy;
  limits: {
    deadlineAt: string;
    maxDurationMs?: number;
    maxTokens?: number;
    maxCostUsd?: number;
    maxOutputBytes?: number;
  };
  resultContract: ResultContract;
}

interface FactoryProvider {
  capabilities(): Promise<FactoryCapabilities>;
  submit(job: FactoryJob): Promise<FactoryHandle>;
  status(handle: FactoryHandle): Promise<FactoryStatus>;
  collect(handle: FactoryHandle): Promise<FactoryResult>;
  cancel(handle: FactoryHandle): Promise<void>;
  release(handle: FactoryHandle): Promise<TeardownReceipt>;
}
```

Mandatory rules:

- Inputs are uploaded archives, blobs, or CAS digests—not office host paths.
- A job receives no live office mount, office vault, executor, or runtime handle.
- Credentials require explicit grants and must never appear as host vault paths in a package.
- Execution is at-least-once; external side effects use the idempotency key.
- Durable results must be collected before teardown.
- After `release()`, the job filesystem must be inaccessible.
- Unsupported capabilities fail explicitly; adapters never silently weaken a request.

Capability reports include at least:

```ts
interface FactoryCapabilities {
  packageTransport: "upload" | "object-url" | "controller-native";
  credentialMode: "egress-inject" | "guest-visible" | "none";
  maxParallel: number;
  hardDeadline: boolean;
  artifactCollection: boolean;
  teardownEvidence: "verified" | "provider-ack" | "best-effort";
  networkModes: Array<"open" | "restricted" | "none">;
}
```

## Provider-neutral test cases

### FT-01 — Input package integrity

Submit text, nested files, a binary, manifest, and digest. Mutate the source office after submission.

Expected: the job observes exactly the submitted snapshot and matching digest; no host path reference exists.

### FT-02 — No live office mount

Create sentinel files in offices A and B; package only the declared A input. Search the guest filesystem and attempt parent/sibling traversal.

Expected: B and un-packaged A data are invisible. Providers must not use shared office PVCs or bind mounts.

### FT-03 — Credential grant scope

Grant endpoint A but not endpoint B. Exercise expired grants, wrong audiences, logs, stdout, artifacts, and results.

Expected: unauthorized access fails and raw secrets never appear in package/results/logs. A `guest-visible` provider is reported as weaker than `egress-inject`.

### FT-04 — Parallel fan-out and isolation

Submit eight jobs with different IDs and staggered delays.

Expected: concurrency respects `maxParallel`; jobs share no filesystem, env, or processes; result association uses job ID rather than completion order; capacity pressure queues or rejects explicitly.

### FT-05 — Deadline and budget

Run a long sleep with a 500 ms deadline, excessive output, and token/cost limit cases.

Expected: normalized `timeout` or `budget_exceeded`; both provider and mikan watchdog terminate; `collect()` returns the final state; no later side effects occur.

### FT-06 — Result contract

Cover stdout/stderr, exit code, structured JSON, valid/missing artifacts, schema violations, and oversized results.

Expected: `completed`, `failed`, `invalid_output`, and `timeout` remain distinct. Error text never masquerades as successful output.

### FT-07 — Collect before teardown

Run `collect → verify digest → release`, then retry status, collect, and filesystem access.

Expected: collection is repeatable before release; filesystem access fails afterward; receipt states the teardown evidence level.

### FT-08 — Cross-job data destruction

Job A writes a unique sentinel and is released. Job B uses the same provider/template.

Expected: B cannot observe A's files, env, history, or secrets. Provider E2E proves control-plane deletion and non-visibility, not physical cryptographic erasure unless the provider actually guarantees it.

### FT-09 — Retry and idempotency

Inject timeouts and HTTP 503 into submit, status, collect, and release; retry with one idempotency key.

Expected: one logical job, repeatable collection/release, reconciliation after an uncertain submit, and idempotent job-side effects.

### FT-10 — Cancellation/teardown race

Call cancel and release concurrently and repeatedly during execution.

Expected: idempotent operations, observable final state, no process/lease/grant leak.

### FT-11 — Network contract

Exercise DNS, HTTPS, allowed and denied hosts/ports, inbound reachability, IP bypass, DNS rebinding, and credential-broker access.

Expected: observed behavior exactly matches the requested mode. `open` remains open; `restricted` cannot be bypassed by alternate addresses or ports.

### FT-12 — Crash and reconciliation

Kill the adapter after package upload, during execution, and after result upload.

Expected: idempotency key recovers the logical job, completed results survive, completed work is not rerun, and orphaned jobs are eventually reclaimed.

## Test environments

### Local fake — every CI run

A deterministic Vitest provider controls latency, duplicate responses, failures, capacity, grants, deadlines, crashes, reconciliation, and teardown ledger. It verifies the state machine, not provider isolation.

### Local Docker — integration gate

Each job uses a short-lived container with no office bind mounts, uploaded tar/blob input, tmpfs or temporary volume, an isolated network, resource limits, and a local HTTPS credential broker. After every test, assert no containers, volumes, networks, or grants remain.

Docker should cover FT-01–05, FT-07–11.

### Provider E2E — credentials required

- **Kubernetes Agent Sandbox**: dedicated namespace/cluster, controller, isolation RuntimeClass, registry, and artifact store.
- **Cloud Run**: project, Artifact Registry, Cloud Run job/service, GCS package/result buckets, dedicated service account, and credential broker.
- **Cloudflare Sandbox**: future Factory Worker/API, Sandbox binding, package/result storage, and explicit destroy support. The current `/exec` bridge cannot pass this suite.
- **E2B**: API key, fixed template/region, artifact endpoint, and an explicit weak-isolation test for guest-visible credentials.

Provider E2E is never silently skipped in a release pipeline that claims support for that provider.

## First-party references

- Kubernetes Agent Sandbox: https://github.com/kubernetes-sigs/agent-sandbox
- Cloud Run container contract: https://cloud.google.com/run/docs/container-contract
- Cloud Run task timeout: https://cloud.google.com/run/docs/configuring/task-timeout
- Cloudflare Sandbox: https://developers.cloudflare.com/sandbox/
- E2B Sandbox: https://e2b.dev/docs/sandbox
- E2B filesystem: https://e2b.dev/docs/filesystem
