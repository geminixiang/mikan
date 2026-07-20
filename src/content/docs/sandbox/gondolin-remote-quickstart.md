---
title: Gondolin remote worker quickstart
description: Bring up a dial-home gondolin:remote worker and run an initial end-to-end test.
---

This walks you from nothing to a working `gondolin:remote` sandbox: mikan on one
side, a worker that dials home on the other, a real VM opened on demand, and data
moving between them. Start with the one-command smoke test, then the manual walkthrough.

For repeated create/exec/stop coverage after the fault-injection path, set a positive
cycle count. Each cycle concurrently places two conversations, requires one runtime on
each worker, verifies independent workspace round-trips, and stops both runtimes:

```bash
MIKAN_SMOKE_SOAK_CYCLES=10 scripts/smoke-test-remote-worker.sh
```

The protocol and settings reference lives in
[the remote worker page](../gondolin-remote-worker/).

## Fastest check: the smoke test

On a machine that already has a built `dist/`, the guest image, Node ≥ 23.6, QEMU, and
Go (or a `mikan-worker` binary on `PATH`):

```bash
npm run build
npm run gondolin:image:build      # once; skip if ~/.cache/gondolin already has it
scripts/smoke-test-remote-worker.sh
```

It auto-provisions the gateway CA, enrols a worker with a one-time token, opens a
sandbox, runs a command in the guest, verifies bidirectional workspace data, and
restarts the worker daemon and gateway independently. Each post-restart lease fences
the old VM before recreating it, including a delayed-write command that must not reach
the workspace after gateway reconnect. It then kills the placed worker and proves that
the old detached runtime stops before fenced failover moves the conversation to the
second worker. A green `✓ gondolin:remote is working on this machine` means
authentication, reconnect, epoch-fenced runtime recreation, fenced two-worker failover,
sandbox lifecycle, and data transfer are healthy on that machine.

## Manual walkthrough (two terminals, one machine)

This is the same path the smoke test automates, done by hand so you can watch it. Host
and worker share the machine's filesystem, so the shared-storage requirement is met for
free.

### 1. Configure mikan for the gateway

In your mikan state dir's `settings.json`, enable the worker gateway. Omit the
certificate fields and mikan provisions its own CA on first start. `workspaceRoot`
is **required** — it is the worker-side path mount sources are translated to; without
it every runtime is rejected with "escapes the workspace root":

```jsonc
{
  "sandbox": {
    "gondolin": {
      "remote": {
        "imageSelector": "mikan-sandbox:latest",
        "gateway": {
          "port": 8433,
          "hostnames": ["127.0.0.1"],
          "workspaceRoot": "/home/you/mikan-workspace", // worker-side path
        },
      },
    },
  },
}
```

The worker-side `workspaceRoot` and its subdirectories (the conversation dirs,
`MEMORY.md`, `skills`, `events`) must exist on the worker — mounts point at real
paths there. Create it before connecting; on shared storage this happens once.

Start mikan against a workspace, in remote mode:

```bash
node dist/main.js --sandbox=gondolin:remote --state-dir ~/.mikan ~/mikan-workspace
```

### 2. Mint a join token

In a second terminal:

```bash
node dist/main.js --worker-token --state-dir ~/.mikan
```

This prints a single-use token (15-minute expiry), the CA pin, and a ready-to-run join
command.

### 3. Enrol and connect the worker

Install the worker binary (from a checkout this builds from source):

```bash
scripts/install-mikan-worker.sh
```

Run the join command it printed, pointing `--worker-entry` at your `dist/`:

```bash
mikan-worker join https://127.0.0.1:8433 \
  --token <token> --ca-pin sha256:<hex> --name dev-worker \
  --workspace-root ~/mikan-workspace \
  --worker-entry "$(pwd)/dist/sandbox/gondolin-worker-main.js"

sudo mikan-worker install-service --config ~/mikan-worker/config.json
```

The join token is only used for initial enrollment. The installed service starts now
and reconnects after either machine restarts without minting another token. For
foreground debugging, use `mikan-worker connect --config ~/mikan-worker/config.json`
instead. mikan logs `Gondolin worker joined: dev-worker (…)`.

### 4. Run something

Send the bot a message that runs a command (e.g. `pwd && uname -a`). mikan places the
conversation on the worker, opens a VM there, and runs it. Files your commands write
under `/workspace` appear in `~/mikan-workspace` and vice-versa.

## Two machines

Before enrollment, run the non-destructive preflight from the mikan host. It only
connects to SSH targets explicitly supplied on the command line; it does not discover,
install, restart, or partition anything:

```bash
MIKAN_GATEWAY_HOST=mikan.internal \
MIKAN_WORKSPACE_ROOT=/srv/mikan-workspace \
MIKAN_WORKER_WORKSPACE_ROOT=/srv/mikan-workspace \
MIKAN_WORKER_ENTRY=/opt/mikan/dist/sandbox/gondolin-worker-main.js \
scripts/preflight-gondolin-fleet.sh worker-a worker-b
```

The preflight fails unless the targets report distinct boot/machine identities, usable
KVM/HVF and QEMU, Node >= 23.6, `mikan-worker`, the runtime entry, gateway TCP
reachability, a canonical shared workspace, mutable-write latency <= 500 ms, and
bidirectional visibility of host/worker marker files. It writes a timestamped evidence
log. Passing this only establishes prerequisites; it does **not** replace the fault and
soak sequence below.

For the distributed promotion gate, enrol **two workers on two distinct machines**, not
two daemon processes on one machine. Give each worker a unique `--name` and local
`--state-dir`, but mount the same workspace path on both. Each daemon exclusively locks
its state directory, so accidentally sharing one state directory fails fast.

Capture the authenticated Admin diagnostics before each fault and verify both workers
report `reachable: true`, protocol version 2, acceptable `clockSkewMs`/
`clockUncertaintyMs`, distinct names, and no `workspaceError`. Then run one long-lived
conversation through this sequence:

1. stop and restart its worker service; verify the next lease gets a higher epoch,
   stops the surviving old-epoch VM, recreates it, and retains the workspace marker;
2. stop and restart the gateway; verify both workers reconnect and the session remains
   usable;
3. partition the placed worker from the gateway while leaving shared storage mounted;
   verify no replacement appears before the reported fence expires;
4. verify the old runtime process exits, then verify placement moves to the other
   physical worker and the workspace marker remains intact;
5. break and restore the shared mount, verifying placement is rejected while degraded
   and resumes only after a successful mutable probe;
6. run repeated concurrent create/exec/write/stop cycles and retain worker, gateway,
   storage-latency, lease-renewal, and disconnect logs as promotion evidence.

Do not shorten the fence or manually kill the old VM to make this pass; the evidence is
specifically that watchdog and lease fencing close the split-brain window.

Same steps as the local walkthrough, with these deployment differences:

- **Shared workspace.** `gondolin:remote` does not copy workspace files — both machines
  must see the same filesystem at their `workspaceRoot`, so a guest's writes reach the
  host and vice-versa. The simplest setup is to NFS-export the workspace from the mikan
  host itself; mikan detects this at startup and, if the workspace is not exported,
  prints the exact commands for your OS (it never modifies system files). Vault
  credential _files_ are the exception — they are shipped to the worker as content and
  projected into the guest per runtime, so they do **not** need shared storage.

  Export from the host (once, by hand):

  ```bash
  # macOS host
  echo "$(pwd)/mikan-workspace -network 100.64.0.0 -mask 255.192.0.0 -mapall=$(id -u):$(id -g)" | sudo tee -a /etc/exports
  sudo nfsd enable && sudo nfsd start

  # Linux host
  echo "$(pwd)/mikan-workspace 100.64.0.0/10(rw,sync,no_subtree_check,all_squash,anonuid=$(id -u),anongid=$(id -g))" | sudo tee -a /etc/exports
  sudo exportfs -ra && sudo systemctl enable --now nfs-server
  ```

  Mount it on each worker over tailscale, and point `--workspace-root` at the mount.
  The worker runs a bounded mutable filesystem probe before placement and marks mounts
  degraded when that probe hangs or exceeds 500 ms; this is a safety ceiling, not a
  promise that latency near the ceiling will perform well:

  ```bash
  sudo mount -t nfs -o vers=3,resvport,nolock <host-tailscale-ip>:<host-workspace-path> /mnt/mikan-workspace
  # then join/connect with --workspace-root /mnt/mikan-workspace
  ```

  `100.64.0.0/10` is the tailscale address range; the `mapall`/`all_squash`
  mapping makes worker writes owned by you on the host. This recipe is only for
  low-latency machines in the same LAN/VPC. Do not put mutable NFS across WAN or a
  relayed Tailscale path: use same-region managed POSIX storage, or keep the deployment
  in preview until generation sync is implemented. The [workspace transport
  research](../gondolin-workspace-transport-research/) explains that open design.
  Other same-region shared POSIX mounts can work, but object/FUSE filesystems must be
  validated against agent write/rename/locking behavior rather than assumed compatible.

- **Reachable gateway.** The worker dials the host, so the host's gateway port must be
  reachable from the worker; the worker needs nothing inbound. Put the host's real
  hostname/IP in `gateway.hostnames` so the auto-issued server certificate is valid for
  it, and use that address in the join command.
- **Clock discipline.** Lease fences persist wall-clock deadlines so they survive host
  restarts. Keep mikan and worker hosts on a monitored NTP/chrony source and alert on
  large forward clock steps; a forward jump can consume safety time. The runtime
  watchdog and 45-second grace protect normal skew/jitter and bounded hard-close time,
  not arbitrarily incorrect clocks or a storage server that ignores fencing tokens.
- **Worker prerequisites.** The worker machine needs Node ≥ 23.6, QEMU with KVM, the
  mikan `dist/`, and the built guest image (`npm run gondolin:image:build` there). The
  `--worker-entry` path is on the worker. `scripts/init-mikan-worker-host.sh` installs
  the system packages (including `e2fsprogs` and `lz4`, which the image build needs) and
  the worker binary on Debian/Ubuntu:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/geminixiang/mikan/main/scripts/init-mikan-worker-host.sh | sudo -E bash
  ```

  On a cloud VM, hardware virtualization must be enabled (e.g. GCP
  `--enable-nested-virtualization` on an N2/N2D/C2/C3 type — E2 does not support it);
  confirm with `ls /dev/kvm`.

Install the worker binary on the second machine with:

```bash
curl -fsSL https://raw.githubusercontent.com/geminixiang/mikan/main/scripts/install-mikan-worker.sh | sh
```

(needs a release carrying the binaries; otherwise run the script from a checkout to
build from source).

## Troubleshooting

- **`no gondolin remote worker is reachable`** — the worker has not connected; check
  `mikan-worker connect` is running and the gateway port is reachable.
- **`CA pin mismatch`** — the `--ca-pin` does not match the gateway's CA; re-mint the
  token (the pin is printed with it).
- **`vfs mount … not ready`** — a stale dist; rebuild (`npm run build`) on the worker.
- **Command runs but files do not appear across machines** — the two `workspaceRoot`s
  are not the same shared filesystem.
