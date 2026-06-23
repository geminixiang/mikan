# Gondolin sandbox bridge

這個範例把 `@earendil-works/gondolin` 包成 mikan 相容的 HTTP bridge，讓 mikan 可用：

```bash
mikan --sandbox=gondolin:mikan-local /path/to/workspace
```

## 安裝與啟動

```bash
cd examples/gondolin-sandbox-bridge
npm install --ignore-scripts
GONDOLIN_WORKSPACE=/path/to/workspace \
GONDOLIN_BRIDGE_PORT=8788 \
npm start
```

另一個 shell 啟動 mikan：

```bash
export GONDOLIN_SANDBOX_URL="http://127.0.0.1:8788"
mikan --sandbox=gondolin:mikan-local /path/to/workspace
```

如果要保護 bridge：

```bash
export GONDOLIN_SANDBOX_TOKEN="replace-me"
export BRIDGE_TOKEN="replace-me"
```

## API

mikan 會呼叫：

- `GET /health`
- `POST /exec`

`POST /exec` payload：

```json
{
  "sandboxId": "mikan-local-d123",
  "command": "pwd",
  "cwd": "/workspace",
  "timeoutSeconds": 30,
  "secrets": {
    "env": {
      "MIKAN_PROXY_INJECT_HEADERS": "{...}"
    }
  }
}
```

回應：

```json
{ "stdout": "", "stderr": "", "code": 0 }
```

## Secret / proxy 語意

mikan 不會把普通 vault env 送進 `/exec` payload，因為 sandbox command 可以直接讀取環境變數。只有 `MIKAN_PROXY_INJECT_HEADERS` 會放在 `secrets.env`。

bridge 會把 `MIKAN_PROXY_INJECT_HEADERS` 轉成 Gondolin `createHttpHooks()` policy，讓 Gondolin host-side HTTP policy 負責替允許 host 的 outbound request 做 secret replacement。secret value 不會作為 `vm.exec()` env 傳入 VM。

目前這個範例保留最小實作；production bridge 應依實際 CLI（`gh`、`gcloud`、`gws`、`sentry-cli`）加上 intercepted-command wrappers，把 CLI credential discovery 轉成 Gondolin placeholder header 或短期 host-side policy。
