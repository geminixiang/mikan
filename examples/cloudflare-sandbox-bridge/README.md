# mikan Cloudflare Sandbox Bridge

這個範例把 `@cloudflare/sandbox` 包成一個簡單的 HTTP bridge，讓 mikan 可用：

```bash
mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

## 內容

- `src/index.ts`: Worker bridge，提供 `/health` 與 `/exec`
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
  "cwd": "/workspace",
  "secrets": {
    "env": {
      "MIKAN_PROXY_INJECT_HEADERS": "{...}"
    }
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

## 限制

- 目前 bridge 只提供 command execution；沒有自動同步宿主機 workspace
- 遠端 `/workspace` 只是 container 內目錄，不是本機 `/path/to/workspace` 的 mount
- 普通 vault env 不會送進 Cloudflare sandbox，因為 command 可以直接讀環境變數
- `MIKAN_PROXY_INJECT_HEADERS` 會由 bridge 轉成短期 proxy session；sandbox 只拿到 `HTTP_PROXY` / `http_proxy` capability URL，真正 header secret 由 bridge-side proxy 注入
- proxy 只支援 HTTP proxy request；HTTPS `CONNECT` 不能修改加密後的 header，bridge 會回 501
- `secrets.files` 不會自動投影到 Cloudflare sandbox
- 如果你要讓 remote sandbox 看見 repo 檔案，需自行設計 upload/sync 流程
