# Sandbox 與 Vault

這份文件說明 mikan 目前支援的 sandbox 模式，以及 credential vault 在各模式下的行為。

## 支援模式

| 模式                                                        | 執行位置              | Vault env injection | Vault key 語意               | 備註                                                                               |
| ----------------------------------------------------------- | --------------------- | ------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| `host`                                                      | 宿主機                | 不注入              | 可存，但執行時不用           | 最適合本機開發；不把 vault env 放進 host process                                   |
| `container:<name>`                                          | 既有 Docker container | 注入                | `container-<name>`           | one container one vault；多人共用同一 container 就共用該 vault                     |
| `image:<image>`                                             | mikan 管理的 Docker   | exec 時短暫注入     | generated conversation vault | 目前最推薦的隔離模式；vault 不會作為長期 bind mount 留在 container 內              |
| `firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]` | Firecracker VM        | 注入                | generated conversation vault | Alpha 超早期；VM 需自行啟動，workspace 需在 VM 內掛到 `/workspace`，目前不建議使用 |
| `cloudflare:<sandbox-id>`                                   | Cloudflare Worker     | proxy-only          | generated conversation vault | Experimental；普通 vault env 不會進 sandbox；host workspace 不會自動同步           |
| `gondolin:<sandbox-id>`                                     | Gondolin micro-VM     | proxy-only          | generated conversation vault | Experimental；普通 vault env 不會進 VM；secret 由 bridge-side policy 注入          |

`docker:*` 不是可用模式；請改用 `container:*` 或 `image:*`。

## 能力差異

`image:<image>` 是目前主要開發與推薦的 sandbox 模式；其他模式保留為本機開發、相容、或實驗用途，部分能力不會補齊。

| 能力                                 | `host`   | `container:<name>` | `image:<image>` | `firecracker:*` | `cloudflare:*` | `gondolin:*`   |
| ------------------------------------ | -------- | ------------------ | --------------- | --------------- | -------------- | -------------- |
| command 執行                         | ✅       | ✅                 | ✅              | ✅              | ✅             | ✅             |
| mikan 管理 runtime lifecycle         | 不適用   | ❌                 | ✅              | ❌              | ❌             | bridge 管理    |
| per-conversation container / runtime | ❌       | ❌                 | ✅              | 需自行管理      | bridge 衍生 id | bridge 衍生 id |
| per-conversation vault env           | ❌       | ❌                 | ✅              | ✅              | ❌             | ❌             |
| vault file 執行期短暫投影            | ❌       | ❌                 | ✅              | ❌              | ❌             | bridge 實作    |
| workspace 自動掛載                   | host     | 需自行掛載         | ✅              | 需自行掛載      | ❌             | bridge 掛載    |
| private workspace mount mode         | 不適用   | ❌                 | ✅              | ❌              | ❌             | ❌             |
| idle auto-stop / recreate            | 不適用   | ❌                 | ✅              | ❌              | ❌             | bridge 管理    |
| CPU / memory default limits          | ❌       | ❌                 | ✅              | ❌              | ❌             | bridge 管理    |
| `/pi-sandbox boost`                  | ❌       | ❌                 | ✅              | ❌              | ❌             | ❌             |
| agent `sandbox` tool 設定 limits     | ❌       | ❌                 | ✅              | ❌              | ❌             | ❌             |
| 推薦程度                             | 本機開發 | legacy / 相容      | 主線            | alpha           | experimental   | experimental   |

---

## State directory 與 vault 位置

state directory 預設是：

```text
~/.mikan/
```

其中重要內容包含：

```text
~/.mikan/
├── settings.json
└── vaults/
    └── <vault-id>/
```

也可以用 `--state-dir` 指定：

```bash
mikan --state-dir=/secure/mikan-state --sandbox=container:mikan-tools /path/to/workspace
```

此時 credential 會在：

```text
/secure/mikan-state/vaults/
```

全域設定檔位於 `<state-dir>/settings.json`。Conversation-local 設定位於 `<working-directory>/<conversationId>/settings.json`，用來覆蓋該 conversation 的全域預設。

啟動時 mikan 會拒絕使用 world-writable 或非目前使用者擁有的 `--state-dir`，避免本機其他使用者竄改 settings 或 vault。

---

## Vault 內容

每個 vault 是 `vaults/` 下的一個目錄，裡面可包含：

- `env` file：`KEY=value` 形式的環境變數
- file credentials：例如 `gws.json`、`.ssh/config`

mount target 從檔名/路徑自動推斷（例如 `gws.json` → `/root/.config/gws/credentials.json`、`.ssh/` → `/root/.ssh`）。

範例：

```text
~/.mikan/vaults/
└── container-mikan-tools/
    ├── env
    └── gws.json
```

`env` 範例：

```env
GH_TOKEN=ghp_xxx
GITHUB_OAUTH_ACCESS_TOKEN=gho_xxx
```

---

## `host`

```bash
mikan --sandbox=host /path/to/workspace
```

特性：

- commands 直接在宿主機執行
- 不注入 vault env
- `/login` 仍可把 credential 存進 `state-dir/vaults`

適合：

- 本機開發
- 不希望 mikan 把 vault credential 放進 host command process

---

## `container:<name>`

```bash
docker run -d --name mikan-tools \
  -v /path/to/workspace:/workspace \
  alpine:latest sleep infinity

mikan --sandbox=container:mikan-tools /path/to/workspace
```

特性：

- mikan 使用 `docker exec` 在既有 container 中執行 command
- container 內 workspace 預期是 `/workspace`
- vault key 是：

```text
container-<name>
```

例如：

```bash
--sandbox=container:mikan-tools
```

會使用：

```text
~/.mikan/vaults/container-mikan-tools/
```

這是 **one container one vault**：

- 不同 container 有不同 vault
- 多個使用者如果共用同一個 container，就共用同一個 container vault

限制：

- mikan 只在 `docker exec` 時注入 env
- `docker exec` 不能新增 bind mount
- vault file credential 會被保存，但目前不會自動投影到 container 內的 target path

---

## `image:<image>`

```bash
# Pull the prebuilt image from GHCR
# Release builds publish :tools, :<version>, and :latest / :beta
# Pushes to main also publish :edge
docker pull ghcr.io/geminixiang/mikan-sandbox:tools

# Run mikan with managed per-conversation containers
mikan --sandbox=image:ghcr.io/geminixiang/mikan-sandbox:tools /path/to/workspace
```

如果你想自行客製 image，也可以本地 build：

```bash
docker build -f docker/mikan-sandbox.Dockerfile -t mikan-sandbox:tools .
mikan --sandbox=image:mikan-sandbox:tools /path/to/workspace
```

特性：

- mikan 會為每個 conversation 建立一個獨立 vault 與 container
- 每個 container 會綁定自己的 Docker bridge network，彼此預設互相隔離
- container 內只會看到 `/workspace/MEMORY.md`、`/workspace/skills`、`/workspace/events` 與當前 conversation 目錄
- vault env 會在每次 `docker exec` 時透過臨時 env file 注入，不寫進 container 設定
- vault file credential 會在單次 command 執行期間 staging 到 target path，command 結束後清除並還原原 target
- vault path 不會作為 Docker bind mount 注入 managed container；`docker inspect ...HostConfig.Binds` 不應出現 vault 目錄
- 若 vault env 設定 `MIKAN_PROXY_INJECT_HEADERS`，mikan 會在單次 command 期間啟動 sandbox-local HTTP proxy，並設定 `HTTP_PROXY` / `http_proxy`，讓 HTTP outbound request 經 proxy 補 header
- 閒置 container 會自動 stop；下次需要時再 start 或 recreate

vault key 選擇邏輯：

1. 直接使用 conversation ID 作為 vault key，例如 `d123`
2. 該 conversation 的 credentials / mounts / env 都寫入這個 vault
3. 對應的 managed container 會使用同一個 key，例如 `mikan-sandbox-d123`

適合：

- 多使用者共用一個 mikan instance
- 需要 per-conversation env/file credential isolation
- 想比 shared container 更安全，但又不想直接上 Firecracker

完整驗證流程請見 [Sandbox / Vault 驗證計畫](./sandbox-verification.md)。

### 容器資源限制

在 `settings.json` 中可設定每個 managed container 的 CPU 與記憶體上限：

```json
{
  "sandbox": {
    "cpus": "0.5",
    "memory": "512m",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    }
  }
}
```

| 欄位                   | 說明                                       | 範例值           |
| ---------------------- | ------------------------------------------ | ---------------- |
| `sandbox.cpus`         | CPU 核心數上限（浮點數字串）               | `"0.5"`, `"2"`   |
| `sandbox.memory`       | 記憶體上限（Docker memory 格式）           | `"512m"`, `"2g"` |
| `sandbox.boost.cpus`   | `/pi-sandbox boost` 暫時套用的 CPU 上限    | `"2"`, `"4"`     |
| `sandbox.boost.memory` | `/pi-sandbox boost` 暫時套用的 memory 上限 | `"4g"`, `"8g"`   |

- 建立新 container 時，限制直接加進 `docker run` 參數
- 已在執行的 container 會在下次 provision 時透過 `docker update` 立即套用新限制，不需重新建立
- `/pi-sandbox` 會顯示目前 conversation 的有效限制
- `/pi-sandbox boost` 會把目前 conversation 暫時升級到 `sandbox.boost` 規格；boost 狀態跟著 container，container stop 後就結束
- agent 可用內建 `sandbox` tool 查詢或暫時設定目前 conversation 的 CPU / memory limit；這類 override 也會在 container stop 後清除

---

## `firecracker:<vm-id>:<host-path>`

警告：Firecracker 支援仍在 alpha 超早期階段。目前僅適合實驗與驗證，不建議作為一般開發或正式環境的主要 sandbox 模式。大多數情況下請優先使用 `image:<image>`。

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace /home/mikan/workspace
```

完整格式：

```text
firecracker:<vm-id>:<host-path>[:<ssh-user>[:<ssh-port>]]
```

範例：

```bash
mikan --sandbox=firecracker:192.168.1.100:/home/mikan/workspace:root:22 /home/mikan/workspace
```

特性：

- mikan 透過 SSH 進 VM 執行 command
- VM 內 workspace 預期是 `/workspace`
- vault env 會透過 SSH stdin 注入，避免 secret 出現在宿主機 command line
- vault 選擇邏輯：
  1. 直接使用 conversation ID 作為 vault key（例如 `d123`）
  2. 找不到 vault 時不注入 env

限制：

- VM lifecycle 由你管理
- workspace mount 由你管理
- vault file credential 會被保存，但目前不會自動投影到 VM 內的 target path

---

## `cloudflare:<sandbox-id>`

警告：Cloudflare 支援目前是 experimental。mikan 會透過你自行部署的 Cloudflare Worker bridge 呼叫 `@cloudflare/sandbox`，但不會自動把宿主機 workspace 同步到遠端 container。

```bash
export CLOUDFLARE_SANDBOX_URL="https://your-bridge.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="replace-me" # optional

mikan --sandbox=cloudflare:mikan-remote /path/to/workspace
```

特性：

- mikan 會把 remote sandbox id 衍生為 `<base-sandbox-id>-<vault-key>`
- 普通 vault env 不會放進 `/exec` payload，也不會成為 remote command 的環境變數
- 只有 `MIKAN_PROXY_INJECT_HEADERS` 會以 `secrets.env` 送到 bridge；範例 Cloudflare bridge 會建立短期 proxy session，只把 `HTTP_PROXY` / `http_proxy` capability URL 注入 sandbox，header secret 由 bridge-side proxy 加上
- vault 選擇邏輯和 `image` 類似：使用 conversation ID 產生 platform-scoped vault key

限制：

- 遠端 `/workspace` 不會自動 mirror 本機工作目錄
- 因此 `pwd` 會顯示 `/workspace`，但 `ls` 可能是空的；這是預期行為，不代表它正在讀你的本機 repo
- vault file credential 目前不會自動投影到 Cloudflare sandbox
- 需要自行部署 bridge Worker 與對應 container image

可直接使用範例 bridge：

- [examples/cloudflare-sandbox-bridge/README.md](../examples/cloudflare-sandbox-bridge/README.md)

---

## `gondolin:<sandbox-id>`

警告：Gondolin 支援目前是 experimental。mikan 會透過本機 HTTP bridge 呼叫 `@earendil-works/gondolin`，由 bridge 管理 local micro-VM、workspace mount、HTTP policy 與 secret handling。

```bash
export GONDOLIN_SANDBOX_URL="http://127.0.0.1:8788"
export GONDOLIN_SANDBOX_TOKEN="replace-me" # optional

mikan --sandbox=gondolin:mikan-local /path/to/workspace
```

特性：

- mikan 會把 sandbox id 衍生為 `<base-sandbox-id>-<vault-key>`
- 普通 vault env 不會放進 `/exec` payload，也不會成為 VM command 的環境變數
- 只有 `MIKAN_PROXY_INJECT_HEADERS` 會以 `secrets.env` 送到 bridge
- bridge 可把 `MIKAN_PROXY_INJECT_HEADERS` 轉成 Gondolin host-side HTTP hooks，讓 secret 由 host-side policy 處理；sandbox 只能看到 hook 產生的非 secret env，不會看到 vault secret value
- workspace 是否掛載、VM lifecycle、HTTP/TLS policy 都由 bridge 控制

限制：

- 需要自行啟動 bridge process
- mikan 本體不直接 import `@earendil-works/gondolin`，避免把本機 VM runtime 綁成主程式 dependency
- production bridge 仍需依 `gh`、`gcloud`、`gws`、`sentry-cli` 補 intercepted-command wrappers

可直接使用範例 bridge：

- [examples/gondolin-sandbox-bridge/README.md](../examples/gondolin-sandbox-bridge/README.md)

---

## `/login` 與 vault

使用者在私訊中執行：

```text
/login
```

mikan 會產生一個 15 分鐘有效的 onboarding link。使用者可在網頁中：

- 儲存任意 API key / env var
- 走 GitHub OAuth
- 走 Google Workspace CLI OAuth

`/login` 只能在 DM / 私訊使用，避免共享頻道中的其他人取得 credential onboarding link。

### 啟用 link server

正式部署時，設定公開 URL：

```bash
export LINK_URL="https://mikan.example.com"
```

若沒有設定 `LINK_PORT`，mikan 會在 `LINK_URL` 存在時預設使用 port `8181`。

也可以明確指定：

```bash
export LINK_PORT=8181
```

若只是本機測試，也可以只設：

```bash
export LINK_PORT=8181
```

此時 `/login` link 會使用：

```text
http://localhost:8181
```

OAuth callback URL 是：

```text
<LINK_URL>/oauth/callback
```
