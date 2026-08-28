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
    "thinkingLevel": "off",
    "autoReply": {
      "provider": "anthropic",
      "model": "claude-haiku-4-5"
    }
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
    "workspace": {
      "doorPolicy": "isolated"
    },
    "defaultSharedVault": ""
  }
}
```

## 設定欄位

以下是 onboarding 產生的值。解析後的全域設定必須包含 `llm.provider`、`llm.model` 與 `llm.thinkingLevel`；其他欄位可省略。

| 欄位                           | Onboarding 值       | 說明                                                                                         |
| ------------------------------ | ------------------- | -------------------------------------------------------------------------------------------- |
| `llm.provider`                 | `anthropic`         | 主要 AI 供應商                                                                               |
| `llm.model`                    | `claude-sonnet-4-6` | 主要模型名稱                                                                                 |
| `llm.thinkingLevel`            | `off`               | `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`                                  |
| `llm.autoReply.provider`       | `anthropic`         | 用來評估 auto-reply 規則的選用模型供應商                                                     |
| `llm.autoReply.model`          | `claude-haiku-4-5`  | 用來評估 auto-reply 規則的選用模型                                                           |
| `sentry.dsn`                   | 未設定              | Sentry DSN；敏感的 prompt 與 tool 內容會被遮蔽                                               |
| `sandbox.boost.cpus`           | `2`                 | `/pi-sandbox boost` 套用的暫時 CPU 限制                                                      |
| `sandbox.boost.memory`         | `4g`                | `/pi-sandbox boost` 套用的暫時記憶體限制                                                     |
| `sandbox.workspace.doorPolicy` | `isolated`          | `isolated` 把每個對話鎖在自己的 office 資料內；`trusted` 則明確允許協作式的 workspace layout |
| `sandbox.workspace.layout`     | `conversation`      | 生效的 layout：isolated 一律使用 `conversation`；trusted 使用 `shared-support` 或 `full`     |
| `sandbox.defaultSharedVault`   | 空白                | 複製到符合資格之 membership-trust image/Cloudflare 對話的共享 vault                          |
| `slack.replyMode`              | `top-level`         | Slack 回應模式：`top-level` 或 `thread`                                                      |

`/pi-model` 會寫入部分對話覆寫；`/pi-sandbox door <default|isolated|shared|full>` 會寫入該對話的 `sandbox.workspace` 覆寫。Admin portal 則同時能設定各 office 與全域的 door policy。Auto-reply 是否啟用及其規則文字由 `/pi-auto-reply` 與對話的 `auto-reply` marker file 管理，而非 JSON 設定欄位。

Door policy 與 layout 是一起解析的。`isolated` 一律代表 `conversation` layout：只掛載該 office 自己的目錄。`trusted` 則代表 `shared-support`——該 office 再加上 workspace 層級的 `MEMORY.md`、`skills/` 與 `events/`——或 `full`，也就是掛載整個 workspace root。door policy 是 `trusted` 但未指定 layout 時，會解析為 `shared-support`。

舊版的 `sandbox.image.workspaceMount` 為了遷移仍然讀得到：`private` 代表 `trusted` + `shared-support`，`full` 代表 `trusted` + `full`。全新安裝會寫入標準的、與後端無關的設定，並預設為 `isolated`。

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
| `mikan ext ...`                                                    | 管理 harness extensions；執行 `mikan ext` 查看子指令                   |
| `mikan office list`                                                | 列出已註冊的 office、已啟用的平台，以及待處理的 legacy 遷移            |
| `mikan office claim <conversationId> <platform>`                   | 指定開機時無法歸屬的 legacy raw-id 目錄屬於哪個平台                    |

`mikan office` 接受 `--state-dir <dir>` 與 `--workspace <dir>`；workspace 預設為 `<state-dir>/workspace`。`claim` 只會記錄這個決定——實際搬移由 daemon 在下次啟動時執行，因此請在 daemon 停止的狀態下執行它。

## 環境變數別名

透過 mikan 設定 helper 讀取的環境變數也接受 `MIKAN_` 前綴。例如，`MIKAN_SLACK_APP_TOKEN` 與 `MIKAN_LINK_URL` 分別是 `SLACK_APP_TOKEN` 與 `LINK_URL` 的 fallback；未加前綴的值優先。`SENTRY_DSN` 是例外：請直接設定，或在 `settings.json` 中設定 `sentry.dsn`。

daemon 的完整環境介面在原始碼樹中以 manifest 宣告；`mikan env` 會印出依平台與功能分組、帶註解的清單，並附上每個變數目前的狀態，讓你不必讀程式碼就能稽核一份部署。

mikan 會將日誌寫到 stdout/stderr。請使用 PM2、systemd、Docker 或 hosting platform 導向並保留日誌。
