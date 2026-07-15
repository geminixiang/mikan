---
title: Gondolin remote worker quickstart
description: Bring up a dial-home gondolin:remote worker and run an initial end-to-end test.
---

This walks you from nothing to a working `gondolin:remote` sandbox: mikan on one
side, a worker that dials home on the other, a real VM opened on demand, and data
moving between them. Start with the one-command smoke test, then the manual walkthrough.

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
sandbox, runs a command in the guest, and verifies a file written inside the guest
lands on the host filesystem — the whole `gondolin:remote` path on one machine. A green
`✓ gondolin:remote is working on this machine` means comms, sandbox lifecycle, and data
transfer are all healthy.

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

mikan-worker connect --config /etc/mikan-worker/config.json
```

mikan logs `Gondolin worker joined: dev-worker (…)`.

### 4. Run something

Send the bot a message that runs a command (e.g. `pwd && uname -a`). mikan places the
conversation on the worker, opens a VM there, and runs it. Files your commands write
under `/workspace` appear in `~/mikan-workspace` and vice-versa.

## Two machines

Same steps, with the worker on a second host. Three differences:

- **Shared workspace.** `gondolin:remote` does not copy workspace files — both machines
  must see the same filesystem at their `workspaceRoot` (NFS or another shared POSIX
  mount). Point mikan's working directory and the worker's `--workspace-root` at the two
  mounts of that one filesystem. Vault credential _files_ are the exception: they are
  projected into the guest per runtime, not shared.
- **Reachable gateway.** The worker dials the host, so the host's gateway port must be
  reachable from the worker; the worker needs nothing inbound. Put the host's real
  hostname/IP in `gateway.hostnames` so the auto-issued server certificate is valid for
  it, and use that address in the join command.
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
