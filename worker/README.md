# mikan-worker

Go daemon that hosts Gondolin runtimes for a remote mikan over mutual TLS. It
supervises the same detached Node worker processes
(`dist/sandbox/gondolin-worker-main.js`) that local `gondolin:default` uses, and
adds the network boundary: client-certificate authentication, durable leases
with monotonic fencing epochs, capacity reporting, and a per-command byte
tunnel to each runtime's session IPC socket. Protocol details live in
`src/content/docs/sandbox/gondolin-remote-worker.md`.

Go was chosen for this component deliberately: memory safety, a first-class
mTLS/HTTP stack in the standard library (zero third-party dependencies), and
`CGO_ENABLED=0` static binaries that cross-compile from any dev machine to
`linux/amd64` and `linux/arm64` workers.

## Install

Prebuilt static binaries (linux/amd64, linux/arm64, darwin/arm64, darwin/amd64)
are attached to every [GitHub release](https://github.com/geminixiang/mikan/releases),
with a `SHA256SUMS.txt`:

```bash
curl -fsSLO https://github.com/geminixiang/mikan/releases/latest/download/mikan-worker_<tag>_linux_amd64
sha256sum -c --ignore-missing mikan-worker_<tag>_SHA256SUMS.txt
install -m 0755 mikan-worker_<tag>_linux_amd64 /usr/local/bin/mikan-worker
mikan-worker version
```

## Build from source

```bash
cd worker
go build ./cmd/mikan-worker                      # host platform
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o mikan-worker-linux-amd64 ./cmd/mikan-worker
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o mikan-worker-linux-arm64 ./cmd/mikan-worker
```

## Run

The worker host needs Node 23.6+ (for Gondolin), QEMU with KVM, mikan's `dist/`
output, and the guest image (`npm run gondolin:image:build`). Provision a CA,
a server certificate, and one client certificate per mikan host, then:

```bash
mikan-worker \
  --listen :8433 \
  --cert server.pem --key server-key.pem --client-ca ca.pem \
  --client-cn mikan-host \
  --state-dir /var/lib/mikan-worker \
  --worker-entry /opt/mikan/dist/sandbox/gondolin-worker-main.js \
  --workspace-root /srv/mikan-workspace
```

Use a dedicated client CA for this listen-mode trust domain and set `--client-cn` to
the Common Name of the mikan host certificate. Do not reuse the dial-home enrollment
CA.

`--workspace-root` restricts mount sources and must be the worker-side mount of
the same shared POSIX filesystem the mikan host uses as its workspace.

## Dial-home mode

For NAT'd workers, `mikan-worker connect` dials mikan's gateway instead of listening.
Enroll with a one-time token (mint it on the host with `mikan --worker-token`):

```bash
mikan-worker join https://mikan.internal:8433 \
  --token <token> --ca-pin sha256:<hex> --name linux-1 \
  --workspace-root /srv/mikan-workspace \
  --worker-entry /opt/mikan/dist/sandbox/gondolin-worker-main.js
sudo mikan-worker install-service --config ~/mikan-worker/config.json
```

`join` generates a local keypair, exchanges the token for a CA-signed client
certificate over a pinned connection, and writes persistent credentials + config.
`install-service` installs and starts an idempotent systemd service, so later host or
worker restarts do not require another token. See
`src/content/docs/sandbox/gondolin-remote-worker.md` for the full protocol.

## Layout

- `cmd/mikan-worker` — flags, mode dispatch (serve / connect / join), mTLS wiring
- `internal/api` — protocol handlers, lease authorization, session tunnel, janitor
- `internal/dialhome` — outbound control channel, RPC-over-frames, dial-back tunnels
- `internal/join` — one-time-token enrollment: keygen, CSR, CA pinning, config write
- `internal/lease` — durable fenced leases (`leases.json`)
- `internal/runtime` — Node worker supervision, handshake, inventory rediscovery
- `internal/cgroup` — best-effort cgroup v2 CPU/memory confinement on Linux
