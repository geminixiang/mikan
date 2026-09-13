---
title: 設定
description: 設定啟動流程、全域與對話設定、平台憑證、sandbox 限制及環境變數。
---

## 首次設定

mikan 在正常啟動前需要全域設定檔。請先建立並檢查一次，再以 workspace 啟動 mikan：

```bash
mikan onboard
mikan --sandbox=host /path/to/workspace
```

預設 state directory 是 `~/.mikan`。若選擇其他位置，onboarding 與正常啟動時須使用相同的 `--state-dir`：

```bash
mikan onboard --state-dir=/secure/mikan-state
mikan --state-dir=/secure/mikan-state /path/to/workspace
```

mikan 會以 `0700` mode 建立不存在的 state directory。既有目錄必須由目前使用者擁有，且不得為 world-writable。使用 sandbox 模式時，請將它放在 workspace 外，避免工具存取憑證或管理員設定。

## 設定位置

| 範圍 | 路徑                                                  | 用途                   |
| ---- | ----------------------------------------------------- | ---------------------- |
| 全域 | `<state-dir>/settings.json`                           | 每個對話都需要的預設值 |
| 對話 | `<state-dir>/conversations/<officeKey>/settings.json` | 單一對話的部分覆寫     |

對話設定以 host 上的內容為準。舊版 `<workspace>/<officeKey>/settings.json` 檔案會在首次存取時移轉，之後不再從 sandbox 可見的 workspace 讀取。

### Office key

每個對話都是一個 _office_，由它的平台加上該平台的原始 conversation id 來識別。儲存路徑使用由兩者推導出的 office key——`v1-<platform>-<readable-id>-<hash>`，例如 `v1-slack-c0aaaaaa1-1f4b9c0d2e3a5b7c`——因此就算兩個平台剛好共用同一個 raw conversation id，也絕不可能定址到對方的檔案、設定或憑證。同一個 key 也用來命名該 office 在 workspace 中的目錄、它的 state directory 與它的 vault。

Office key 無法反推回原始平台 id，因此 host 會在 `<state-dir>/office-registry.json` 保留一份 registry，記錄每個 office 的平台與 conversation id。可用 `mikan office list` 讀取。

若從以原始平台 id 儲存對話的版本升級上來，下次啟動時會把那些目錄、vault 與 state tree 遷移到 office key 佈局；見[部署](/zh-tw/deployment/#跨-office-佈局遷移的升級)。

## 產生的設定

`mikan onboard` 會建立：

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off"
  },
  "slack": {
    "replyMode": "top-level"
  },
  "sandbox": {
    "cpus": "0.5",
    "memory": "1g",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    },
    "defaultSharedVault": ""
  }
}
```

## 設定欄位

以下是 onboarding 產生的值。解析後的全域設定必須包含 `llm.provider`、`llm.model` 與 `llm.thinkingLevel`；其他欄位可省略。

| 欄位                           | Onboarding 值       | 說明                                                                                 |
| ------------------------------ | ------------------- | ------------------------------------------------------------------------------------ |
| `llm.provider`                 | `anthropic`         | 主要 AI 供應商                                                                       |
| `llm.model`                    | `claude-sonnet-4-6` | 主要模型名稱                                                                         |
| `llm.thinkingLevel`            | `off`               | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`                          |
| `sentry.dsn`                   | 未設定              | Sentry DSN；敏感的 prompt 與 tool 內容會被遮蔽                                       |
| `sandbox.boost.cpus`           | `2`                 | `/pi-sandbox boost` 套用的暫時 CPU 限制                                              |
| `sandbox.boost.memory`         | `4g`                | `/pi-sandbox boost` 套用的暫時記憶體限制                                             |
| `sandbox.workspace.doorPolicy` | 未設定              | 明確覆寫：`isolated` 把 office 鎖在自身資料內；`trusted` 允許協作式 workspace layout |
| `sandbox.workspace.layout`     | 未設定              | 明確的 trusted layout 覆寫：`shared-support` 或 `full`                               |
| `sandbox.workspace.visibility` | 未設定              | 在 `shared-support` 下，`public` 允許讀寫全域記憶，`private` 則設為唯讀              |
| `sandbox.defaultSharedVault`   | 空白                | 複製到符合資格之 membership-trust image/Cloudflare 對話的共享 vault                  |
| `slack.replyMode`              | `top-level`         | Slack 回應模式：`top-level` 或 `thread`                                              |

`/pi-model` 會寫入部分對話覆寫；`/pi-sandbox door <default|isolated|shared|shared-private|full>` 會寫入該對話的 `sandbox.workspace` 覆寫。Admin portal 則同時能設定各 office 與全域的 door policy。

Slack auto-reply 可透過 `/pi-auto-reply on|off` 修改，並以 conversation office 裡的 `auto-reply`（on）或 `auto-reply.disabled`（off）marker 檔保存。Marker 內容會被忽略：啟用後，該 Slack channel 中未明確 address mikan 的 top-level human message 會直接觸發，不使用 rules 或 judge model。Top-level `autoReply` 與 `llm.autoReply` JSON 設定仍維持退役並被忽略。

Onboarding 不會寫入 `sandbox.workspace`。若沒有明確的全域或對話覆寫，mikan 會跟隨已記錄的平台頻道可見性。目前 Slack 公開頻道會解析為 `trusted` + `shared-support` + `public`，因此可讀寫 workspace 全域 `MEMORY.md`；Slack 私密頻道會解析為 `trusted` + `shared-support` + `private`，全域記憶以唯讀方式掛載。Slack DM、外部共享頻道、未知頻道類型，以及未記錄頻道可見性的其他平台都會解析為 `isolated`。這表示新部署的 Slack 公開頻道不需要額外 door-policy 指令，就會把內容寫入共享 workspace 記憶。

Door policy 與 layout 是一起解析的。`isolated` 一律代表 `conversation` layout：只掛載該 office 自己的目錄。`trusted` 則代表 `shared-support`——該 office 再加上 workspace 層級的 `MEMORY.md`、`skills/` 與 `events/`——或 `full`，也就是掛載整個 workspace root。door policy 是 `trusted` 但未指定 layout 時，會解析為 `shared-support`。只有 `image:*` 能強制 isolated projection 或唯讀共享記憶；`host`、`container:*` 與 `cloudflare:*` 對這些 projection 會 fail closed，因此必須改用 `image:*`，或明確選擇 trusted 讀寫 policy。

舊版的 `sandbox.image.workspaceMount` 為了遷移仍然讀得到：舊的 `workspaceMount: "private"` 為維持原行為，代表 `trusted` + `shared-support` 且 visibility 為 **public/read-write**；它不同於新的 `sandbox.workspace.visibility: "private"`，後者會把共享記憶設為唯讀。舊的 `workspaceMount: "full"` 代表 `trusted` + `full`。

## MCP servers

`mcpServers` 可連接 stdio 或 Streamable HTTP MCP server，並將工具公開為 `mcp__<server>__<tool>`。MCP server 在 host 端執行或連線，`env`／`headers` 中的憑證不會暴露給模型或 sandbox。

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "package@fixed-version"],
      "env": { "API_TOKEN": "..." }
    },
    "internal-docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

每個 entry 必須只使用一種 transport：`command`（可搭配 `args`、`env`）或 `url`（可搭配 `headers`）。`disabled: true` 可在不刪除設定的情況下停用 server。全域與對話設定會依 server name 合併；對話設定可以覆寫或停用同名的全域 server，其他全域 entries 仍會保留。

Admin 的 MCP 面板提供 repository-owned 的精選 Marketplace。安裝前會顯示完整 host command 或 remote endpoint、所需憑證、來源、目標 scope 與安全警告；確認後只會建立一般的 `mcpServers` entry。Local package 版本固定，不另建 installed database 或自動更新服務，也不把 catalog 收錄視為安全認證。Local stdio preset 會在 mikan host 執行程式碼；remote preset 則會收到送往其工具的呼叫與資料。

OpenConnector 只由啟動時的 deployment-owned 完整 `OPENCONNECTOR_ENDPOINT` 與 host-only `OPENCONNECTOR_ADMIN_TOKEN` 設定，不會出現在 Admin Marketplace。mikan 會注入保留名稱 `open-connector` 的 server；global 或 conversation `mcpServers` 設定都不能取代或停用它。每個 Slack Conversation office 在共用 provider OAuth connections 的同時擁有自己的 OpenConnector runtime identity，而且只有 endpoint 的 origin 可以收到 admin credential。Office 首次建立 runner 時，mikan 會建立名稱為 `mikan:slack:<workspace-id>:<channel-id>` 的 token、複製目前 OpenConnector deployment 的 action／proxy policy，並把 token 存在該 office 的私有 State-dir。Provisioning 失敗只會停用該 runner 的 OpenConnector。Managed sandbox 不會收到 admin 或 runtime token；host sandbox 沒有這項隔離，必須視為 trusted。

## 平台憑證

正常 bot 模式至少需要一組完整的平台憑證：

| 平台     | 必要環境變數                                                                                              | 選用變數                               |
| -------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Slack    | `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`                                                                      | —                                      |
| Telegram | `TELEGRAM_BOT_TOKEN`                                                                                      | —                                      |
| Discord  | `DISCORD_BOT_TOKEN`                                                                                       | —                                      |
| GitHub   | `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`，以及 `GITHUB_APP_PRIVATE_KEY` 或 `GITHUB_APP_PRIVATE_KEY_PATH` | `GITHUB_REPOS`, `GITHUB_POLL_INTERVAL` |

各平台的設定與權限請參閱[平台接入](/zh-tw/platform-adapters/)。

## CLI 參考

| 指令或選項                                                         | 用途                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `mikan onboard [--state-dir=<dir>]`                                | 建立必要的全域設定檔                                                   |
| `mikan [--state-dir=<dir>] [--sandbox=<mode>] [working-directory]` | 啟動已設定的平台 bot；working directory 預設為 `<state-dir>/workspace` |
| `mikan env`                                                        | 顯示完整的環境變數清單，以及目前已設定的項目                           |
| `mikan --download <channel-id>`                                    | 下載 Slack 頻道歷史；需要 `SLACK_BOT_TOKEN`                            |
| `mikan --version`                                                  | 顯示已安裝版本                                                         |
| `mikan --help`                                                     | 顯示 CLI 用法與平台 token 摘要                                         |
| `mikan office list`                                                | 列出已註冊的 office、已啟用的平台，以及待處理的 legacy 遷移            |
| `mikan office claim <conversationId> <platform>`                   | 指定開機時無法歸屬的 legacy raw-id 目錄屬於哪個平台                    |

`mikan office` 接受 `--state-dir <dir>` 與 `--workspace <dir>`；workspace 預設為 `<state-dir>/workspace`。`claim` 只會記錄這個決定——實際搬移由 daemon 在下次啟動時執行，因此請在 daemon 停止的狀態下執行它。

## Observability：OTLP、Sentry 與 Phoenix

mikan 只擁有一條 OpenTelemetry traces/metrics pipeline，並以標準 OTLP HTTP/protobuf 匯出。只有明確設定 OTLP endpoint 且 `OTEL_SDK_DISABLED` 不是 `true` 時才啟用；零設定維持 no-op。Collector 可用 `OTEL_EXPORTER_OTLP_ENDPOINT`，或分別設定 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 與 `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`。base endpoint 會附加 `/v1/traces`、`/v1/metrics`，per-signal endpoint 則必須包含完整路徑。認證應放在對應的 `*_HEADERS`，不要放進 URL。

本機 [Arize Phoenix](https://github.com/Arize-ai/phoenix) 可設定 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:6006/v1/traces`。Phoenix 接收 traces，不提供 OTLP metrics ingestion；metrics 請送至 Collector 或其他 backend。mikan 在同一組 spans 上輸出不含內容的標準 GenAI attributes 與最小 OpenInference projection，保留 provider、model、token counts、duration、status、session attribution 與 tool name，不建立重複 spans。

`SENTRY_DSN`（或相容的 `sentry.dsn`）啟用 Sentry issue reporting，並把錯誤連到目前的 OpenTelemetry trace；Sentry 不會建立第二條 application trace/metric pipeline。同一份 traces 若要同時送到 Phoenix 與 Sentry，請由 OpenTelemetry Collector fan-out。Sentry direct OTLP 目前支援 traces/logs，不支援 OTLP metrics。

只支援 `http/protobuf`；`OTEL_TRACES_EXPORTER=none`、`OTEL_METRICS_EXPORTER=none` 可個別關閉 signal。mikan 不會輸出 prompts、completions、訊息文字、tool arguments/results、檔案內容、credentials、tokens 或絕對路徑；但會輸出 model ID、token/cost 總量、耗時、payload 大小、tool 類別，以及 retry/compaction/budget 次數等無內容的操作 metadata。平台 conversation、session、message、thread 與 user identifiers 會以 raw operational ID 匯出，讓 trace 能直接對應來源；human-readable username、channel name 與 workspace name 仍不會輸出。resource attributes 採 allowlist，請勿在 `OTEL_RESOURCE_ATTRIBUTES` 放 secrets 或 paths。shutdown 會先 drain conversation work，再 flush/shutdown OTLP，最後 close Sentry。

## 環境變數別名

透過 mikan 設定 helper 讀取的環境變數也接受 `MIKAN_` 前綴。例如，`MIKAN_SLACK_APP_TOKEN` 與 `MIKAN_LINK_URL` 分別是 `SLACK_APP_TOKEN` 與 `LINK_URL` 的 fallback；未加前綴的值優先。`SENTRY_DSN` 是例外：請直接設定，或在 `settings.json` 中設定 `sentry.dsn`。

daemon 的完整環境介面在原始碼樹中以 manifest 宣告；`mikan env` 會印出依平台與功能分組、帶註解的清單，並附上每個變數目前的狀態，讓你不必讀程式碼就能稽核一份部署。

mikan 會將日誌寫到 stdout/stderr。請使用 PM2、systemd、Docker 或 hosting platform 導向並保留日誌。
