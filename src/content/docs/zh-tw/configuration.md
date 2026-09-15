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

| 欄位                         | Onboarding 值       | 說明                                                                     |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------ |
| `llm.provider`               | `anthropic`         | 主要 AI 供應商                                                           |
| `llm.model`                  | `claude-sonnet-4-6` | 主要模型名稱                                                             |
| `llm.thinkingLevel`          | `off`               | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`              |
| `sentry.dsn`                 | 未設定              | Sentry DSN；敏感的 prompt 與 tool 內容會被遮蔽                           |
| `sandbox.boost.cpus`         | `2`                 | `/pi-sandbox boost` 套用的暫時 CPU 限制                                  |
| `sandbox.boost.memory`       | `4g`                | `/pi-sandbox boost` 套用的暫時記憶體限制                                 |
| `office.visibility`          | 未設定              | 僅限對話的覆寫：`private` 把 Slack 公開頻道縮為 private office；不能放寬 |
| `sandbox.defaultSharedVault` | 空白                | 複製到符合資格之 membership-trust image/Cloudflare 對話的共享 vault      |
| `slack.replyMode`            | `top-level`         | Slack 回應模式：`top-level` 或 `thread`                                  |

`/pi-model` 會寫入部分對話覆寫；`/pi-sandbox visibility <private|default>` 會寫入該對話的 `office.visibility` 覆寫；admin portal 提供同一個開關。

Slack auto-reply 可透過 `/pi-auto-reply on|off` 修改，並以 conversation office 裡的 `auto-reply`（on）或 `auto-reply.disabled`（off）marker 檔保存。Marker 內容會被忽略：啟用後，該 Slack channel 中未明確 address mikan 的 top-level human message 會直接觸發，不使用 rules 或 judge model。Top-level `autoReply` 與 `llm.autoReply` JSON 設定仍維持退役並被忽略。

Office visibility 跟隨 Slack 對話類型（ADR 0008）。公開頻道是 **public** office：其他所有 office 都能在 `/workspace/public/<office key>` 唯讀它，且它可以寫入 workspace 全域的 `MEMORY.md` 與 `skills/`。私人頻道、DM、群組 DM、外部共享頻道，以及尚未觀察到類型的對話都是 **private** office：只有自己看得到，可讀共用知識與 public office，但不會寫回。每個 office 的掛載形狀相同；沒有任何佈局會掛載 workspace root。

只有 `image:*` 會強制執行 visibility。`host`、`container:*`、`cloudflare:*` 讓所有 office 共用同一個檔案系統，屬於受信任部署；private office 在這些模式下會照常服務，並記錄一次警告。

已退役的 door policy 設定（`sandbox.workspace.doorPolicy`、`layout`、`visibility`，以及舊版 `sandbox.image.workspaceMount`）仍可解析以載入舊檔，但不再影響投影。仍宣告 `full` 的 office 會在每次程序啟動時被回報一次；其他公開頻道仍可透過 `/workspace/public` 讀取，要存取其他 private office 則需要 ADR 0008 描述的成員身分授權，而不是更大的掛載。

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

OpenConnector 是一個附帶部署預設值的一般 MCP server。`OPENCONNECTOR_ENDPOINT` 指定預設的 `open-connector` server，`OPENCONNECTOR_ADMIN_TOKEN` 是 host-only 的憑證，用來替各 conversation 產生 runtime token。當 Slack conversation 未在 global 或 conversation 設定宣告 `open-connector` 時，mikan 會建立名稱為 `mikan:slack:<workspace-id>:<channel-id>` 的 token（複製目前 OpenConnector deployment 的 action／proxy policy），並以一般 `mcpServers` entry 形式存入該 conversation 的 host-only settings。之後這個 entry 會出現在 Admin MCP 面板，可像其他 server 一樣測試、停用、移除，或改成自架的 OpenConnector；移除後下次回應會重新產生預設 entry，停用則關閉整合。Admin token 只會送到預設 endpoint 的 origin，不會進入 settings 或 sandbox。既有的 `open-connector-runtime-token.json` 可在停止 daemon 後用 `mikan office migrate-openconnector` 轉換。

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
