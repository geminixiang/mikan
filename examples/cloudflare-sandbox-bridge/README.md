# mikan Cloudflare Sandbox Bridge

這個範例把 `@cloudflare/sandbox` 包成一個簡單的 HTTP bridge，讓 mikan 可用：

```bash
mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

## 內容

- `src/index.ts`: Worker bridge，提供 `/health`、`/exec`、`/env`、`/mkdir`、`/write-file`
- `Dockerfile`: Cloudflare sandbox container entrypoint
- `wrangler.jsonc`: Durable Object / Containers 設定
- `package.json`: 安裝 `@cloudflare/sandbox` 與 `wrangler`

## 啟動

```bash
cd examples/cloudflare-sandbox-bridge
npm install
npx wrangler secret put BRIDGE_TOKEN
npm run deploy
```

部署後，設定 mikan：

```bash
export CLOUDFLARE_SANDBOX_URL="https://<your-worker>.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="<same-secret>"

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

注意：遠端 sandbox 內的工作目錄會是 `/workspace`，但這個目錄不會自動同步本機 repo。所以 `pwd` 會回 `/workspace`，而 `ls` 可能是空的，這是目前預期行為。

## API

### `GET /health`

回傳 bridge 存活狀態。

### `POST /exec`

Request body:

```json
{
  "sandboxId": "mikan-remote-slack-u123",
  "command": "pwd",
  "timeoutSeconds": 30,
  "cwd": "/workspace"
}
```

`env` 欄位仍可使用（舊版 mikan 相容），但新版 mikan 會改用 `/env` 做 session-scoped 注入，不再於每次 exec 重送 secrets。

Response body:

```json
{
  "stdout": "/workspace\n",
  "stderr": "",
  "code": 0
}
```

### `POST /env`

把 vault env 注入 sandbox session（`setEnvVars`），每個 instance 只需呼叫一次：

```json
{
  "sandboxId": "mikan-remote-slack-u123",
  "env": { "OPENAI_API_KEY": "..." }
}
```

### `POST /mkdir`

```json
{ "sandboxId": "mikan-remote-slack-u123", "path": "/root/.config/gh" }
```

### `POST /write-file`

寫入 credential 檔案，`mode` 為選填八進位字串（寫入後以 `chmod` 套用）：

```json
{
  "sandboxId": "mikan-remote-slack-u123",
  "path": "/root/.config/gh/hosts.yml",
  "content": "github.com:\n  token: ...",
  "mode": "600"
}
```

## 限制

- 沒有自動同步宿主機 workspace
- 遠端 `/workspace` 只是 container 內目錄，不是本機 `/path/to/workspace` 的 mount
- 如果你要讓 remote sandbox 看見 repo 檔案，需自行設計 upload/sync 流程
