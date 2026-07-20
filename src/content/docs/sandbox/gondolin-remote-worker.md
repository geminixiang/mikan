---
title: Gondolin remote worker protocol
description: mTLS worker daemon protocol for running gondolin runtimes on a remote Linux host.
---

`mikan-worker` is a Go daemon that hosts Gondolin runtimes on a (typically Linux/KVM)
worker machine for a mikan host running elsewhere. It implements the Phase 2–3 slices of
the [migration research](./gondolin-migration-research/): authenticated transport,
heartbeat, durable leases with fencing epochs, capacity reporting, and multi-worker
placement. One authoritative mikan host schedules across one or more workers.

The daemon supervises the same detached Node worker processes
(`dist/sandbox/gondolin-worker-main.js`) that local `gondolin:default` uses, so runtime
behavior — per-conversation VM, drift fingerprints, watchdog self-exit, inventory
records — is identical on both paths. What the daemon adds is the network boundary:
authentication, leases, and a byte tunnel to each runtime's session IPC socket.

## Transport and authentication

All traffic is **mutual TLS**; there are no tokens or passwords. The trusted CA
establishes membership, and in dial-home mode the client certificate CN is also bound
to the worker `name` on every control registration and tunnel preamble. A worker
certificate therefore cannot impersonate another placement identity. Certificates are
provisioned out of band or through the join flow below. The daemon runs in one of two
modes sharing the same protocol implementation:

**Listen mode** — mikan dials the worker (datacenter topology; the worker needs a
stable address and an open port):

```
mikan-worker --listen :8433 \
  --cert server.pem --key server-key.pem --client-ca clients-ca.pem \
  --client-cn mikan-host \
  --state-dir /var/lib/mikan-worker \
  --worker-entry /opt/mikan/dist/sandbox/gondolin-worker-main.js \
  --workspace-root /srv/mikan-workspace
```

Use a dedicated host-client CA for listen-mode workers; do not reuse the dial-home
enrollment CA. `--client-cn` is mandatory and must equal the Common Name in mikan's
client certificate, so another CA member cannot call the worker API.

**Dial-home mode** — the worker dials mikan's worker gateway (GitHub-Actions-runner
topology; NAT-friendly, nothing inbound on the worker, no per-worker URL in mikan's
settings). A worker joins with a one-time token instead of hand-provisioned
certificates (see **Joining a worker** below), then connects from the config the join
wrote:

```
mikan-worker join https://mikan.internal:8433 \
  --token <token> --ca-pin sha256:<hex> --name linux-1 \
  --workspace-root /srv/mikan-workspace \
  --worker-entry /opt/mikan/dist/sandbox/gondolin-worker-main.js
sudo mikan-worker install-service --config ~/mikan-worker/config.json
```

The worker keeps one outbound control connection (register + heartbeat + the same
protocol as RPC frames) and dials back one data connection per session tunnel, so
abort-by-disconnect semantics are identical in both modes. On every reconnect it
re-registers with its machine info and the runtimes that survived the gap, and mikan
logs the join and reconciles placements. mikan enables the gateway with:

Each daemon acquires an exclusive kernel advisory lock on its `--state-dir`; a second
process pointed at the same lease/inventory state fails immediately instead of sharing
leases or refreshing the first daemon's runtime watchdogs. The kernel releases the lock
on clean exit or crash.

The detached runtime heartbeat is admission-bound: the daemon refreshes it only while
an acknowledged dial-home control session is active or after a successful static-mode
lease grant/renewal. A rejected certificate, failed registration, disconnected gateway,
or vanished static host therefore cannot keep old VMs alive behind the host's placement
fence. Heartbeats are atomically published boot-nonce/sequence values; detached workers
measure time since the last observed sequence change with a monotonic clock, so wall-clock
rollback, future file mtimes, and partial writes cannot keep a stale VM alive.

Worker and host clocks must be synchronized. Protocol-v2 health responses include the
worker timestamp; mikan estimates skew using the request midpoint and rejects a worker
when the minimum possible offset exceeds five seconds or the health round trip exceeds
five seconds and cannot establish a safe bound. The authenticated Admin
Gondolin diagnostics expose the estimated skew and network-time uncertainty. This
protects lease/fencing timestamps from a worker whose wall clock is materially wrong.

The control connection is hardened for NAT and stateful firewalls: registration is an
explicit protocol-versioned handshake, and the worker reports itself registered only
after the gateway acknowledges identity, protocol, capacity, and fleet admission.
This handshake is protocol v2. Rolling upgrades are host-first: deploy the new mikan
host/gateway first (it accepts v1 and v2 workers), then replace workers one at a time.
A v2 worker intentionally does not enter service against an older gateway that cannot
acknowledge admission. Protocol-v1 workers may continue existing workloads during the
host-first rollout, but a runtime that requests `sandbox.gondolin.network` requires a
v2 worker and fails closed instead of silently ignoring policy.

Rejected or superseded certificates therefore reconnect with an admission error rather
than entering a false healthy state. After admission, the worker sends
an application heartbeat every 15 seconds, requires a pong within 10 seconds, and
reconnects a half-open connection with exponential backoff plus jitter. Backoff resets
after a minute-long healthy session. TCP keepalives provide an independent fallback,
but application heartbeats are authoritative because some middleboxes silently drop
idle mappings without closing either endpoint.

```jsonc
"sandbox": { "gondolin": { "remote": {
  "imageSelector": "mikan-sandbox:latest",
  "gateway": {
    "port": 8433,
    "certFile": "/etc/mikan/gateway.pem",
    "keyFile": "/etc/mikan/gateway-key.pem",
    "clientCaFile": "/etc/mikan/workers-ca.pem",
    "workspaceRoot": "/srv/mikan-workspace",
    "workers": { "old-box": { "draining": true } }
  }
}}}
```

Dial-home workers advertise their own `--max-runtimes`; host-side `gateway.workers`
entries override capacity or mark a worker draining. Static `workers[]` and the
gateway can be used together.

The mikan host also owns `<state-dir>/gondolin-coordinator.lock` while
`gondolin:remote` is running. A second process using that state directory fails fast.
Dead owners are reclaimed automatically only within the same verified OS boot; after a
host reboot, first confirm no other coordinator can access the fleet, then remove the
stale lock directory manually. Cross-machine or unreadable locks are never broken
automatically.

## Joining a worker

Omit the certificate fields from the gateway config and mikan provisions its own on
first start: a private worker CA plus a gateway server certificate signed by it, both
under the state dir (`gondolin-gateway/`). Workers then enroll with a one-time token
instead of manually copied certificates — the same pattern as a GitHub Actions runner
or `kubeadm join`.

On the mikan host, mint a token:

```
mikan --worker-token --state-dir /path/to/state
```

It prints a single-use token (15-minute expiry), the CA pin, and a ready-to-run join
command. On the worker machine, run that command. `mikan-worker join`:

1. generates an EC keypair locally — the private key never leaves the worker;
2. dials the gateway and presents the token with a certificate signing request;
3. verifies the returned CA against `--ca-pin` **and** re-checks the gateway's own
   server certificate against that CA before trusting anything — a man-in-the-middle
   would need a CA matching the pin;
4. writes `client.pem`, `client-key.pem`, `ca.pem`, and `config.json` (mode `600`) to
   `--dir` (default `~/mikan-worker`), and prints the service installation command.

The token is single-use and the private key is worker-local, so the only secret that
crosses the wire is a short-lived enrollment token, never a long-lived credential.
After joining, install the persistent worker service once:

```bash
sudo mikan-worker install-service --config ~/mikan-worker/config.json
```

The service starts immediately, reconnects automatically, and survives worker and
mikan host restarts without another token. To rotate a worker certificate, mint a name-scoped token:

```bash
mikan --worker-token --worker-name linux-1 --state-dir /path/to/state
```

Then join again with the **same worker name** into a new credential directory; the old certificate remains active until the replacement first registers, then its
fingerprint is durably revoked and cannot reclaim that identity after a gateway
restart. Switch the service to the new `config.json` only after join succeeds.
`mikan-worker connect --config …` remains
available for foreground/debug use; command-line flags override the config when both
are present.

The authenticated Admin Gondolin diagnostics include each worker client certificate's
expiry timestamp and flag certificates with 30 days or less remaining. This is an
operator warning, not automatic rotation; use the name-scoped flow above before
expiry.

## Leases and fencing

Every runtime operation happens under a **lease** on the conversation's instance id.
Leases are durable (`leases.json` under the daemon state dir) and carry a monotonically
increasing **fencing epoch** that survives daemon restarts. Live lease expiry is measured
with the worker process's monotonic clock, so a wall-clock rollback cannot extend a
grant. JSON preserves epochs but cannot preserve a monotonic deadline; after daemon
restart every previous grant is therefore treated as expired and mikan must acquire a
new epoch. Before returning it, the worker stops the surviving old-epoch VM and then
recreates the runtime from durable workspace state; it does not adopt that VM because
a disconnected Gondolin session cannot prove that an already-admitted guest command
has quiesced:

- `POST /v1/leases` `{instanceId, ttlSeconds}` → `{leaseId, epoch, expiresAt}`.
  Acquiring bumps the epoch and supersedes any previous lease for the instance.
- `POST /v1/leases/{leaseId}/renew` extends the expiry (mikan renews on a heartbeat).
- `DELETE /v1/leases/{leaseId}` releases the lease.

Runtime and tunnel requests carry `X-Mikan-Lease` and `X-Mikan-Epoch`. The daemon
rejects any request whose epoch is older than the current epoch for that instance
(`409 stale_epoch`) — a partitioned mikan whose conversation was re-acquired elsewhere
cannot keep writing. A replacement grant is not returned until the worker has
synchronously closed every active session tunnel from older epochs and confirmed that
their VM exited; release and expiry fencing close the current epoch's tunnels and stop
its VM too. Closing only the transport is insufficient because Gondolin may already have admitted
the guest command. Long-running commands therefore cannot keep writing after lease
authority changes. Ensuring a runtime continuously revalidates that lease while it
waits for a VM handshake, so an expiry or superseding acquisition aborts the full VM
process group instead of publishing a late runtime. Idempotency records are scoped to
the lease epoch and cannot replay a prior grant's response. Ensuring under a new epoch
stops any runtime the previous epoch left behind; an expired-lease janitor snapshot
only stops runtimes through that expired epoch, so it cannot race and kill a newly
rebound runtime. Together these rules keep shared-storage single-writer fencing
enforceable on the worker side.

Execution is **at-least-once**: a lost response after a command reached the runtime is
not retried by the transport. Mutating runtime ensures accept an `Idempotency-Key` header scoped to the active lease
epoch; replaying a key under that same grant returns the recorded result instead of
repeating the action.

Credential files are staged outside the shared workspace under immutable
`instance/lease-epoch/content-digest` generations. Targets under `/workspace`, relative
targets, and duplicate targets are rejected at the worker protocol boundary. Failed or
concurrent ensures cannot truncate files backing a live VM, credential content
contributes independently to the worker-side runtime fingerprint, and cleanup removes
only fenced epochs so a stale janitor or release cannot delete a newer epoch's secrets.

## Runtimes

- `POST /v1/runtimes` `{instanceId, imageSelector, mounts, cpus, memory, fingerprint}`
  (lease headers required) — ensures a runtime: adopts a live one with a matching
  fingerprint, otherwise stops the stale one and spawns a fresh Node worker. Returns
  `{sessionId, workerPid, runnerPid, fingerprint, adopted}`. Mount sources are
  worker-local paths; mikan translates its host workspace prefix to the worker's
  `--workspace-root` (shared POSIX storage — both sides mount the same filesystem).
- `GET /v1/runtimes?instanceId=` — live runtimes (adoption / status).
- `GET /v1/runtimes/{sessionId}` — liveness probe for crash detection.
- `DELETE /v1/runtimes/{sessionId}` — stop the worker process (SIGTERM, then SIGKILL
  and orphan-runner reaping, mirroring the local client).

On start the daemon rediscovers runtimes from the Node workers' inventory records —
the same JSON files local mikan uses. They remain alive long enough for deterministic
fencing, but a post-restart lease sends a dedicated no-sync fencing signal, invalidates
any file-projection read already in flight before it can rename stale content onto the
host, and stops the old-epoch runtime before recreating it from the shared workspace. Remote mode does not adopt across lease
epochs and stale guest content cannot be published during that teardown. Each remote
runtime also watches the daemon-owned inventory heartbeat. If the daemon stays
down, the runtime closes its VM before the host's lease-expiry-plus-grace fence permits
placement on another worker; daemon failure therefore cannot leave an unfenced writer
on shared storage.

On Linux the daemon places each Node worker (and thus its QEMU child) in a cgroup v2
slice with `memory.max` and a fractional `cpu.max` quota — strict fractional CPU
limits that the VM's whole-vCPU count cannot express.

## Session tunnel

`GET /v1/runtimes/{sessionId}/session` with `Upgrade: gondolin-session` (lease headers
required) hijacks the connection and splices bytes between the TLS stream and the
runtime's session IPC unix socket. The gondolin session framing travels verbatim:

- client → server: `u32be length` + JSON control message (`exec`, `stdin`, …)
- server → client: `u8 type` + `u32be length` + payload (type 0 JSON, type 1 binary
  stdout/stderr frame)

mikan opens **one tunnel per command**, exactly like the local unix-socket path.
Aborting, timing out, exceeding the output limit, or losing that tunnel reports an
interrupted command and fences the whole runtime before another command is allowed to
use its workspace. Transport EOF alone is not treated as proof that Gondolin cancelled
a command already admitted to the guest. Lease replacement likewise closes the tunnel
**and the old VM** before exposing the new epoch. Vault env vars for a command travel
only inside this mTLS tunnel. Control and
session frames are size-bounded and malformed frames fail closed; tunnel setup errors
are returned immediately over the control channel instead of waiting for a timeout.

## Health and capacity

`GET /v1/health` → OS, architecture, accelerator availability (`/dev/kvm` on Linux),
CPU count, total memory, active runtime count, state-dir path, and protocol version.
mikan polls this as the worker heartbeat. The shared-workspace probe performs mutable
stat/create/write/remove I/O with a bounded wait and a 500 ms admission ceiling;
timeouts, errors, or excessive latency mark the worker degraded until a later healthy
probe.

## Operator diagnostics

When mikan's Admin portal is enabled, authenticated operators can query:

```text
GET /admin/api/sandbox/gondolin?token=<admin-token>
```

The response reports sanitized worker reachability, active/capacity counts, drain and
workspace-degradation state, protocol version, durable conversation placements, and
each placement's remaining fence window. It intentionally omits worker URLs,
certificate/key paths, and workspace host paths. A placement with no `sessionId` is a
write-ahead fence whose runtime creation has not yet been confirmed; it must not be
manually deleted merely to accelerate failover.

## mikan configuration

```jsonc
// settings.json — single worker (a fleet of one)
{
  "sandbox": {
    "gondolin": {
      "remote": {
        "url": "https://worker.internal:8433",
        "caFile": "/etc/mikan/worker-ca.pem",
        "certFile": "/etc/mikan/client.pem",
        "keyFile": "/etc/mikan/client-key.pem",
        "workspaceRoot": "/srv/mikan-workspace",
        "imageSelector": "mikan-sandbox:latest",
      },
    },
  },
}
```

```jsonc
// settings.json — multi-worker fleet; per-worker fields fall back to the inline ones
{
  "sandbox": {
    "gondolin": {
      "remote": {
        "caFile": "/etc/mikan/worker-ca.pem",
        "certFile": "/etc/mikan/client.pem",
        "keyFile": "/etc/mikan/client-key.pem",
        "workspaceRoot": "/srv/mikan-workspace",
        "imageSelector": "mikan-sandbox:latest",
        "queueWaitSeconds": 60,
        "workers": [
          { "name": "linux-1", "url": "https://worker-1.internal:8433", "maxRuntimes": 24 },
          { "name": "linux-2", "url": "https://worker-2.internal:8433", "maxRuntimes": 24 },
          { "name": "old-box", "url": "https://worker-0.internal:8433", "draining": true },
        ],
      },
    },
  },
}
```

Start mikan with `--sandbox=gondolin:remote`. The workspace directory mikan is given
must be the mikan-host mount of the same shared filesystem every worker sees at its
`workspaceRoot`. Image assets live on the workers (build them there with
`npm run gondolin:image:build`); the runtime fingerprint uses the image selector, so
retagging `mikan-sandbox:latest` on a worker is picked up on the next runtime
recreation rather than detected as drift.

## Fleet placement

mikan is the fleet's only scheduler. Each conversation is **sticky**: its first
runtime placement (least-loaded reachable worker with a free `maxRuntimes` slot,
skipping `draining` ones) is persisted in `gondolin-placement.json` under the state
dir, and every later runtime for that conversation goes to the same worker. When all
workers are at capacity, new conversations queue up to `queueWaitSeconds` for a slot.

A worker's `name` is its placement identity — keep it stable across URL or
certificate changes. Marking a worker `draining: true` stops new placements while
existing conversations finish out and disappear through the normal idle stop;
reconciliation and idle sweeps then leave the worker empty, ready to retire.

**Failover is protected by a lease fence.** If a placed worker is unreachable, mikan
refuses to move the conversation until the worker-side lease expiry plus a fencing
grace has passed, measured on mikan's own clock from the last grant or renewal. The
daemon normally stops the runtime in its expiry janitor; if the daemon itself crashed,
the detached runtime's heartbeat watchdog stops it before the host fence opens. Only
then can another worker take over the shared workspace, preserving the single-writer
rule through network partitions and daemon failures. Runtimes found on a worker that
placement says belongs to another (a superseded placement), or that has no durable
placement authority at all, is stopped by periodic fleet reconciliation. The host
writes placement before every remote create, so an unplaced runtime cannot be safely
adopted.
