---
title: Gondolin remote worker protocol
description: mTLS worker daemon protocol for running gondolin runtimes on a remote Linux host.
---

`mikan-worker` is a Go daemon that hosts Gondolin runtimes on a (typically Linux/KVM)
worker machine for a mikan host running elsewhere. It implements the Phase 2 slice of
the [migration research](./gondolin-migration-research/): authenticated transport,
heartbeat, durable leases with fencing epochs, and capacity reporting. One authoritative
mikan host talks to one worker; placement across a fleet is a later phase.

The daemon supervises the same detached Node worker processes
(`dist/sandbox/gondolin-worker-main.js`) that local `gondolin:default` uses, so runtime
behavior — per-conversation VM, drift fingerprints, watchdog self-exit, inventory
records — is identical on both paths. What the daemon adds is the network boundary:
authentication, leases, and a byte tunnel to each runtime's session IPC socket.

## Transport and authentication

All endpoints are HTTPS with **mutual TLS**. The daemon verifies client certificates
against `--client-ca` and mikan verifies the server certificate against its configured
CA. There are no tokens or passwords; possession of a client certificate signed by the
client CA is the authorization boundary. Certificates are provisioned out of band.

```
mikan-worker --listen :8433 \
  --cert server.pem --key server-key.pem --client-ca clients-ca.pem \
  --state-dir /var/lib/mikan-worker \
  --worker-entry /opt/mikan/dist/sandbox/gondolin-worker-main.js \
  --workspace-root /srv/mikan-workspace
```

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
// settings.json
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

Start mikan with `--sandbox=gondolin:remote`. The workspace directory mikan is given
must be the mikan-host mount of the same shared filesystem the worker sees at
`workspaceRoot`. Image assets live on the worker (build them there with
`npm run gondolin:image:build`); the runtime fingerprint uses the image selector, so
retagging `mikan-sandbox:latest` on the worker is picked up on the next runtime
recreation rather than detected as drift.
