# mikan Cloudflare Sandbox Bridge

This example wraps `@cloudflare/sandbox` as a small HTTP bridge so mikan can
run with:

```bash
mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

## Status: legacy, and refused by default

Per [ADR 0004](../../../docs/adr/0004-persistent-offices-and-ephemeral-factory-floors.md),
Cloudflare Sandbox belongs on the future **Factory floor** (disposable,
packaged, fan-out jobs), not in `SandboxConfig` as a Conversation office
backend. It cannot provide a persistent isolated office: the adapter declares
`workspace.managedProjection: false`, so under mikan's default `isolated` door
policy the runtime refuses it with

> Sandbox 'cloudflare' cannot provide an isolated conversation office; use
> image:\* or gondolin:default, or explicitly choose trusted workspace policy

The `cloudflare:` spec still parses and executes, but only with an explicit
`sandbox.workspace.doorPolicy: "trusted"` in `settings.json`. Nothing here is
the factory-floor contract described in
[docs/testing/factory-floor-conformance.md](../../../docs/testing/factory-floor-conformance.md) —
this bridge is `/exec` only and cannot pass that suite.

## Contents

- `src/index.ts`: Worker bridge exposing `/health` and `/exec`
- `Dockerfile`: Cloudflare sandbox container entrypoint
- `wrangler.jsonc`: Durable Object / Containers config
- `package.json`: depends on `@cloudflare/sandbox` and `wrangler`

## Start

```bash
cd deploy/examples/cloudflare-sandbox-bridge
npm install
npx wrangler secret put BRIDGE_TOKEN
npm run deploy
```

After deploy, configure mikan:

```bash
export CLOUDFLARE_SANDBOX_URL="https://<your-worker>.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="<same-secret>"

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

`MIKAN_`-prefixed spellings of both variables work too. `CLOUDFLARE_SANDBOX_CWD`
overrides the exec working directory (default `/workspace`). `mikan env` lists
all three. `BRIDGE_TOKEN` is optional on the worker side: leave it unset and the
bridge accepts unauthenticated requests.

Note: the remote sandbox working directory is `/workspace`, and that directory
is **not** automatically synced from the host repo. So `pwd` returns
`/workspace` while `ls` may be empty — that is expected today.

## API

### `GET /health`

Returns bridge liveness. mikan calls this once at startup to validate the
sandbox spec.

### `POST /exec`

Request body:

```json
{
  "sandboxId": "mikan-remote-c0123456789-3f2a1b9c4d5e",
  "command": "pwd",
  "timeoutSeconds": 30,
  "cwd": "/workspace",
  "env": {
    "OPENAI_API_KEY": "..."
  }
}
```

mikan derives `sandboxId` as `<spec id>-<conversation resource key>`, so each
conversation gets its own sandbox behind one `--sandbox=cloudflare:<id>` spec.

Response body:

```json
{
  "stdout": "/workspace\n",
  "stderr": "",
  "code": 0
}
```

## Limitations

- The bridge only provides command execution; host workspace is not auto-synced
- Remote `/workspace` is an in-container path, not a mount of the host workspace
- mikan vault file mounts are not projected into the Cloudflare sandbox
  (the adapter declares `credentials: { env: true, fileMounts: false }`)
- To make the remote sandbox see repo files, design your own upload/sync flow
