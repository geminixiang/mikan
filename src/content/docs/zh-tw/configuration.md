---
title: 設定
description: 設定啟動流程、全域與對話設定、平台憑證、sandbox 限制及環境變數。
---

## 首次設定

mikan 在正常啟動前需要全域設定檔。請先建立並檢查一次，再以 workspace 啟動 mikan：

```bash
mikan --onboard
mikan --sandbox=host /path/to/workspace
```

預設 state directory 是 `~/.mikan`。若選擇其他位置，onboarding 與正常啟動時須使用相同的 `--state-dir`：

```bash
mikan --onboard --state-dir=/secure/mikan-state
mikan --state-dir=/secure/mikan-state /path/to/workspace
```

mikan 會以 `0700` mode 建立不存在的 state directory。既有目錄必須由目前使用者擁有，且不得為 world-writable。使用 sandbox 模式時，請將它放在 workspace 外，避免工具存取憑證或管理員設定。

## 設定位置

| 範圍 | 路徑                                                       | 用途                   |
| ---- | ---------------------------------------------------------- | ---------------------- |
| 全域 | `<state-dir>/settings.json`                                | 每個對話都需要的預設值 |
| 對話 | `<state-dir>/conversations/<conversationId>/settings.json` | 單一對話的部分覆寫     |

對話設定以 host 上的內容為準。舊版 `<workspace>/<conversationId>/settings.json` 檔案會在首次存取時移轉，之後不再從 sandbox 可見的 workspace 讀取。

## 產生的設定

`mikan --onboard` 會建立：

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
    "image": {
      "workspaceMount": "private"
    },
    "defaultSharedVault": ""
  }
}
```

## 設定欄位

以下是 onboarding 產生的值。解析後的全域設定必須包含 `llm.provider`、`llm.model` 與 `llm.thinkingLevel`；其他欄位可省略。

| 欄位                           | Onboarding 值       | 說明                                                                |
| ------------------------------ | ------------------- | ------------------------------------------------------------------- |
| `llm.provider`                 | `anthropic`         | 主要 AI 供應商                                                      |
| `llm.model`                    | `claude-sonnet-4-6` | 主要模型名稱                                                        |
| `llm.thinkingLevel`            | `off`               | `off`、`minimal`、`low`、`medium`、`high` 或 `xhigh`                |
| `llm.autoReply.provider`       | `anthropic`         | 用來評估 auto-reply 規則的選用模型供應商                            |
| `llm.autoReply.model`          | `claude-haiku-4-5`  | 用來評估 auto-reply 規則的選用模型                                  |
| `sentry.dsn`                   | 未設定              | Sentry DSN；敏感的 prompt 與 tool 內容會被遮蔽                      |
| `sandbox.cpus`                 | `0.5`               | mikan 管理的 image container CPU 限制                               |
| `sandbox.memory`               | `1g`                | mikan 管理的 image container 記憶體限制                             |
| `sandbox.boost.cpus`           | `2`                 | `/pi-sandbox boost` 套用的暫時 CPU 限制                             |
| `sandbox.boost.memory`         | `4g`                | `/pi-sandbox boost` 套用的暫時記憶體限制                            |
| `sandbox.image.workspaceMount` | `private`           | `private` 會公開共用支援檔案與目前對話；`full` 會公開完整 workspace |
| `sandbox.defaultSharedVault`   | 空白                | 複製到符合資格之 membership-trust image/Cloudflare 對話的共享 vault |
| `slack.replyMode`              | `top-level`         | Slack 回應模式：`top-level` 或 `thread`                             |

`/pi-model` 會寫入部分對話覆寫。`/pi-sandbox private|full` 會更新對話的 workspace mount 模式。Auto-reply 是否啟用及其規則文字由 `/pi-auto-reply` 與對話的 `auto-reply` marker file 管理，而非 JSON 設定欄位。

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

| 指令或選項                                                                                  | 用途                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `mikan --onboard [--state-dir=<dir>]`                                                       | 建立必要的全域設定檔                                        |
| `mikan [--state-dir=<dir>] [--sandbox=<mode>] <workspace>`                                  | 啟動已設定的平台 bot                                        |
| `--sandbox=host \| container:<name> \| image:<image> \| firecracker:... \| cloudflare:<id>` | 選擇工具執行模式；預設為 `host`                             |
| `mikan --download <channel-id>`                                                             | 下載 Slack 頻道歷史；需要 `SLACK_BOT_TOKEN`                 |
| `mikan --version`                                                                           | 顯示已安裝版本                                              |
| `mikan ext ...`                                                                             | 管理 harness extensions；執行 `mikan ext --help` 查看子指令 |

## 環境變數別名

透過 mikan 設定 helper 讀取的環境變數也接受 `MIKAN_` 前綴。例如，`MIKAN_SLACK_APP_TOKEN` 與 `MIKAN_LINK_URL` 分別是 `SLACK_APP_TOKEN` 與 `LINK_URL` 的 fallback；未加前綴的值優先。`SENTRY_DSN` 是例外：請直接設定，或在 `settings.json` 中設定 `sentry.dsn`。

mikan 會將日誌寫到 stdout/stderr。請使用 PM2、systemd、Docker 或 hosting platform 導向並保留日誌。
