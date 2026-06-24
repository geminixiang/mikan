---
title: 聊天指令
---

# 聊天指令

mikan 支援跨平台文字指令。在平台支援時，也可使用 slash-command 別名。

| 指令                                                       | 用途                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `/login` / `/pi-login`                                     | 開啟 15 分鐘有效的連結，用來儲存 API keys 或執行內建 OAuth flows。僅限 DM。     |
| `session` / `/session`                                     | 開啟目前工作階段的網頁檢視。僅限 DM。                                           |
| `new` / `/new`                                             | 重設目前工作階段並重新開始。僅限 DM。                                           |
| `model` / `/model` / `/pi-model provider/model[:thinking]` | 切換目前對話使用的 LLM，例如 `/pi-model anthropic/claude-sonnet-4-6:off`。      |
| `auto-reply` / `/pi-auto-reply on\|off\|status`            | 控制目前對話在群組 / 頻道中的 auto-reply。                                      |
| `stop` / `/stop`                                           | 停止目前執行。在 Slack 上，請使用文字指令，確保討論串本地的 stop 路由保持準確。 |
| `/pi-sandbox`                                              | 顯示或暫時提升受管理容器的 CPU / 記憶體限制。                                   |

在 Slack 上，你可以註冊原生指令，例如 `/pi-login`、`/pi-session`、`/pi-model`、`/pi-auto-reply` 與 `/pi-new`。

## Web 工作階段檢視器

工作階段檢視器使用與 login/vault 和 admin 相同的連結伺服器。目前的工作階段檢視可顯示時間軸；當互動式 portal wiring 啟用時，也能把訊息送回該工作階段。

```bash
export LINK_URL="https://mikan.example.com"   # public base URL
export LINK_PORT=8181                         # optional, defaults to 8181
```

本機測試時可以只設定 `LINK_PORT`；mikan 會使用 `http://localhost:<port>`。

關於 admin、login/vault 與 session-view 連結的差異，請參閱 [Portal 驗證與 capability 模型](portal-auth-model.md)。

## OAuth flows

內建 OAuth 文件：

- [GitHub](oauth/github.md)
- [Google Workspace](oauth/google-workspace.md)
- [Google Cloud SDK / gcloud](oauth/google-cloud-sdk.md)
