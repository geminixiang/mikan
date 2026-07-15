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

All traffic is **mutual TLS**; there are no tokens or passwords — possession of a
certificate signed by the trusted CA is the authorization boundary. Certificates are
provisioned out of band. The daemon runs in one of two modes sharing the same
protocol implementation:

**Listen mode** — mikan dials the worker (datacenter topology; the worker needs a
stable address and an open port):

```
mikan-worker --listen :8433 \
  --cert server.pem --key server-key.pem --client-ca clients-ca.pem \
  --state-dir /var/lib/mikan-worker \
  --worker-entry /opt/mikan/dist/sandbox/gondolin-worker-main.js \
  --workspace-root /srv/mikan-workspace
```

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
mikan-worker connect --config /etc/mikan-worker/config.json
```

The worker keeps one outbound control connection (register + heartbeat + the same
protocol as RPC frames) and dials back one data connection per session tunnel, so
abort-by-disconnect semantics are identical in both modes. On every reconnect it
re-registers with its machine info and the runtimes that survived the gap, and mikan
logs the join and reconciles placements. mikan enables the gateway with:

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
   `--dir` (default `/etc/mikan-worker`), and prints a systemd unit.

The token is single-use and the private key is worker-local, so the only secret that
crosses the wire is a short-lived enrollment token, never a long-lived credential.
After joining, `mikan-worker connect --config …` runs from those files; command-line
flags override the config when both are present.

## Leases and fencing

Every runtime operation happens under a **lease** on the conversation's instance id.
Leases are durable (`leases.json` under the daemon state dir) and carry a monotonically
increasing **fencing epoch** that survives daemon restarts:

- `POST /v1/leases` `{instanceId, ttlSeconds}` → `{leaseId, epoch, expiresAt}`.
  Acquiring bumps the epoch and supersedes any previous lease for the instance.
- `POST /v1/leases/{leaseId}/renew` extends the expiry (mikan renews on a heartbeat).
- `DELETE /v1/leases/{leaseId}` releases the lease.

Runtime and tunnel requests carry `X-Mikan-Lease` and `X-Mikan-Epoch`. The daemon
rejects any request whose epoch is older than the current epoch for that instance
(`409 stale_epoch`) — a partitioned mikan whose conversation was re-acquired elsewhere
cannot keep writing. Ensuring a runtime under a new epoch stops any runtime the
previous epoch left behind, and an expired lease's runtimes are stopped by the daemon,
which keeps the shared-storage single-writer rule enforceable on the worker side.

Execution is **at-least-once**: a lost response after a command reached the runtime is
not retried by the transport. Mutating requests accept an `Idempotency-Key` header;
replaying a key returns the recorded result instead of repeating the action.

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
the same JSON files local mikan uses — so runtimes survive daemon restarts too.

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

mikan opens **one tunnel per command**, exactly like the local unix-socket path, so
aborting or timing out a command closes the tunnel and kills the in-flight guest
process. Vault env vars for a command travel only inside this mTLS tunnel.

## Health and capacity

`GET /v1/health` → OS, architecture, accelerator availability (`/dev/kvm` on Linux),
CPU count, total memory, active runtime count, state-dir path, and protocol version.
mikan polls this as the worker heartbeat.

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

**Failover is fenced by lease expiry.** If a placed worker is unreachable, mikan
refuses to move the conversation until the worker-side lease has provably expired
(measured on mikan's own clock from the last grant or renewal). Only then can a new
worker take over the shared workspace — the unreachable daemon's janitor has already
stopped the old runtime, so the single-writer rule holds even through a network
partition. Runtimes found on a worker that placement says belongs to another (a
superseded placement) are stopped by the periodic fleet reconciliation; runtimes with
no placement record at all are adopted instead.
