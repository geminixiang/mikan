# Sandbox / Vault 驗證計畫

目標：確認 `image:*` managed sandbox 在單機部署下不把 vault 長期注入 container；需要補 secret 的 HTTP outbound request 會走執行期 proxy，由 proxy 補 header；同時 `gh`、Google Workspace CLI、`gcloud` 等工具仍能透過執行期 secrets 正常使用；並確認介面能對齊 Cloudflare / 第三方 sandbox。

## 1. 靜態與單元測試

必跑：

```bash
npm test -- test/sandbox.test.ts test/vault.test.ts test/provisioner.test.ts
npm test
npm run build
npm run verify:sandbox-cli-proxy
npx oxfmt --check src/execution-resolver.ts src/sandbox/cloudflare.ts src/sandbox/container.ts src/sandbox/firecracker.ts src/sandbox/index.ts src/sandbox/types.ts test/sandbox.test.ts test/vault.test.ts scripts/verify-sandbox-cli-proxy.mjs
npm run lint
```

驗收標準：

- `test/vault.test.ts` 驗證 `image:*` provisioner 的 Docker mounts 只包含 workspace 相關 mounts，不包含 vault mounts。
- `test/sandbox.test.ts` 驗證 vault file 透過每次 `docker exec` 的臨時 staging 提供，不使用 `docker run -v` 或長期 bind mount。
- `test/sandbox.test.ts` 驗證 secret injection proxy 會依 `MIKAN_PROXY_INJECT_HEADERS` 對目標 host 補 header。
- `npm test` 全量通過。
- `npm run build` 通過。
- lint 無 errors；既有 warnings 需確認不是本次修改新增。
- `verify:sandbox-cli-proxy` 在真 Docker network 中用 `gh`、`gcloud`、`gws`、`sentry-cli` 四種 CLI 形態的命令驗證 proxy env 對 subprocess 生效，且 upstream 收到 proxy 補上的 header。

## 2. Docker container 隔離驗證

準備：

```bash
STATE_DIR=$(mktemp -d)
WORKSPACE=$(mktemp -d)
mkdir -p "$STATE_DIR/vaults/d123/.ssh" "$WORKSPACE/D123"
printf 'GH_TOKEN=dummy-token\nGOOGLE_APPLICATION_CREDENTIALS=/root/.config/gcloud/application_default_credentials.json\n' > "$STATE_DIR/vaults/d123/env"
printf '{"type":"authorized_user","client_id":"dummy","client_secret":"dummy","refresh_token":"dummy"}\n' > "$STATE_DIR/vaults/d123/gcloud-adc.json"
```

以 `image:<image>` 啟動 mikan，觸發 conversation `D123` 執行任一 command 後驗證：

```bash
docker inspect mikan-sandbox-d123 --format '{{json .HostConfig.Binds}}'
```

驗收標準：

- 輸出不得包含 `$STATE_DIR/vaults`、`.ssh`、`gcloud-adc.json`、`gws.json` 等 vault path。
- 只允許 workspace 相關 mounts，例如 `MEMORY.md`、`skills`、`events`、conversation directory，或 full workspace mode 的 `/workspace`。

## 3. 執行期 secrets 清理驗證

在同一個 `image:*` container 中執行：

```bash
# 透過 mikan/agent 執行一次需要 credential target path 的 command
ls -la /root/.config/gcloud || true

# command 結束後直接進 container 檢查
docker exec mikan-sandbox-d123 sh -lc 'test ! -e /root/.config/gcloud/application_default_credentials.json'
```

驗收標準：

- command 執行期間 CLI 可以讀到目標 credential path。
- command 結束後，credential file / directory 不留在 container filesystem。
- 若 target path 原本存在，command 結束後要恢復原內容。

## 4. Proxy secret injection 驗證

設定 vault env：

```env
MIKAN_PROXY_INJECT_HEADERS={"api.internal:8080":{"authorization":"Bearer proxy-secret"}}
```

在同一個 Docker network 放一個測試 upstream，先直接從 sandbox request，再透過 mikan executor request：

```bash
# direct request：upstream 不應收到 Authorization
wget -qO- http://api.internal:8080/direct

# mikan exec request：executor 會啟動 127.0.0.1 proxy 並設定 HTTP_PROXY/http_proxy
wget -qO- http://api.internal:8080/via-proxy
```

驗收標準：

- direct request 不帶 `Authorization`。
- 經 mikan executor 的 request 必須由 inline proxy 補上 `Authorization: Bearer proxy-secret`。
- `npm run verify:sandbox-cli-proxy` 必須證明 `gh`、`gcloud`、`gws`、`sentry-cli` 這類 CLI subprocess 都能透過同一套 proxy env 走代理並讓 upstream 收到補上的 header。
- `MIKAN_PROXY_INJECT_HEADERS` 不會留在 container base env。
- proxy 只在單次 command 存活；command 結束後 proxy process 被清掉。

注意：目前 proxy 對 plain HTTP request 可補 header；HTTPS CONNECT 只能 tunnel，不能在不做 MITM 的情況下修改 TLS 內的 request header。

## 5. CLI 功能煙霧測試

在測試 vault 中放入對應 OAuth / token 後，透過 `image:*` conversation 執行：

```bash
gh auth status
gcloud auth application-default print-access-token
gws --help
```

驗收標準：

- `gh` 使用 `GH_TOKEN` / `GITHUB_TOKEN`，並仍會執行 `gh auth setup-git` bootstrap。
- `gcloud` 能讀取 `GOOGLE_APPLICATION_CREDENTIALS` 指向的臨時 staged credential。
- `gws` 能讀取其預設 target path 的臨時 staged credential。
- 測試後直接 `docker exec` 檢查 credential target path 不殘留。

## 6. Cloudflare / 第三方 sandbox 介面對齊驗證

必查：

- `SandboxSecrets` 只表達 `env` 與 `files`，不暴露 Docker 專屬 mount 語意。
- `CloudflareSandboxExecutor` 透過 payload 的 `env` 傳送 secrets，保留未來 bridge 增加 file projection 的空間。
- `FirecrackerExecutor` 同樣吃 `SandboxSecrets`，避免 adapter API 分裂。

驗收標準：

- `createExecutor(config, secrets, ensureReady)` 是各 sandbox adapter 的共同入口。
- Docker-specific lifecycle / bind mount 邏輯仍只在 `DockerContainerManager` 與 `ContainerExecutor` 內部。
- 新增第三方 sandbox 時不需要讀取 Docker mount 資料結構即可接入 env/file secret 語意。

## 7. 回歸風險檢查

每次修改 sandbox / vault injection 相關程式碼後，至少重跑：

```bash
npm test -- test/sandbox.test.ts test/vault.test.ts test/provisioner.test.ts test/oauth-link-server.test.ts test/link-server.test.ts
npm run build
```

如果改到 OAuth target path、vault file 推斷、或 login portal，需額外手動跑 GitHub、Google Workspace、Google Cloud SDK OAuth onboarding 流程。
