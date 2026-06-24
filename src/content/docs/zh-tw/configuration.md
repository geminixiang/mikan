---
title: 設定
description: 設定全域與對話層級的模型、sandbox、Slack 回覆模式、auto-reply 與 vault 預設值。
---

每個對話的設定位於 `<working-directory>/<conversationId>/settings.json`，並會覆寫該對話的全域設定。

## 範例

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off"
  },
  "sentry": {
    "dsn": "https://examplePublicKey@o0.ingest.sentry.io/0"
  },
  "sandbox": {
    "cpus": "0.5",
    "memory": "512m",
    "boost": {
      "cpus": "2",
      "memory": "4g"
    },
    "image": {
      "workspaceMount": "private"
    },
    "defaultSharedVault": ""
  },
  "slack": {
    "replyMode": "top-level"
  }
}
```

## 欄位

| 欄位                           | 預設值              | 說明                                                  |
| ------------------------------ | ------------------- | ----------------------------------------------------- |
| `llm.provider`                 | `anthropic`         | AI 供應商                                             |
| `llm.model`                    | `claude-sonnet-4-6` | 模型名稱                                              |
| `llm.thinkingLevel`            | `off`               | `off` / `low` / `medium` / `high`                     |
| `sentry.dsn`                   | 未設定              | Sentry DSN；敏感的 prompt / tool 內容會被遮蔽         |
| `sandbox.cpus`                 | 未設定              | 受管理容器的 CPU 限制                                 |
| `sandbox.memory`               | 未設定              | 受管理容器的記憶體限制                                |
| `sandbox.boost.cpus`           | 未設定              | `/pi-sandbox boost` 使用的暫時 CPU 限制               |
| `sandbox.boost.memory`         | 未設定              | `/pi-sandbox boost` 使用的暫時記憶體限制              |
| `sandbox.image.workspaceMount` | `private`           | `private` 只掛載對話工作區；`full` 掛載整個工作區目錄 |
| `sandbox.defaultSharedVault`   | 未設定              | 沒有自有保管庫的對話所使用的預設共享保管庫鍵          |
| `slack.replyMode`              | `top-level`         | Slack 回應模式：`top-level` 或 `thread`               |

`/pi-sandbox` 會顯示目前受管理容器的 CPU / 記憶體限制。`/pi-sandbox boost` 會暫時將 `sandbox.boost` 套用到目前對話；當該沙盒容器停止後，boost 也會結束。

對話本地設定使用相同結構，並會覆寫該對話的全域設定。由 `/pi-model` 寫入的設定通常只包含模型覆寫：

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "thinkingLevel": "off"
  }
}
```

每個環境變數也支援 `MIKAN_` 前綴，用於部署專屬的命名空間。例如，`MIKAN_SLACK_APP_TOKEN` 與 `MIKAN_LINK_URL` 都是可接受的 fallback。未加前綴的變數優先。

mikan 會將日誌寫到 stdout/stderr。請使用你的程序管理器或主機平台（例如 PM2、systemd、Docker，或雲端日誌代理）將日誌導向偏好的後端。
