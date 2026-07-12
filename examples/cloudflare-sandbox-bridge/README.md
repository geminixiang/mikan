# mikan Cloudflare Sandbox Bridge

This example wraps `@cloudflare/sandbox` as a small HTTP bridge so mikan can
run with:

```bash
mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

## Contents

- `src/index.ts`: Worker bridge exposing `/health` and `/exec`
- `Dockerfile`: Cloudflare sandbox container entrypoint
- `wrangler.jsonc`: Durable Object / Containers config
- `package.json`: depends on `@cloudflare/sandbox` and `wrangler`

## Start

```bash
cd examples/cloudflare-sandbox-bridge
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

Note: the remote sandbox working directory is `/workspace`, and that directory
is **not** automatically synced from the host repo. So `pwd` returns
`/workspace` while `ls` may be empty — that is expected today.

## API

### `GET /health`

Returns bridge liveness.

### `POST /exec`

Request body:

```json
{
  "sandboxId": "mikan-remote-slack-u123",
  "command": "pwd",
  "timeoutSeconds": 30,
  "cwd": "/workspace",
  "env": {
    "OPENAI_API_KEY": "..."
  }
}
```

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
- To make the remote sandbox see repo files, design your own upload/sync flow
