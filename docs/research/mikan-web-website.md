# mikan Harness Web Client 架構研究

> 狀態：已由 [ADR 0007](../adr/0007-full-harness-web-client.md) 採納並實作。早期「把 Session／Admin／Vault portal 搬進同一個 SPA」的方案已廢棄。

## 問題定義

`/session`、`/admin`、`/link` 是從 Slack、Telegram、Discord 或 GitHub 傳出的 bearer-capability links。它們分別服務 session 檢視、operator administration 與 credential onboarding；三者沒有共同的頁面 state、使用者流程或授權模型。

新的網站則是另一個完整 client：它需要自己的登入、Conversation 清單、composer、streaming、run/cancel 狀態與 model controls。把 portal React pages import 進 `AppFrame`，會讓 cookie identity 轉換成 portal token，並把三個 capability product 誤當成網站功能模組。

## DeepSeek Harness 的可取之處

對照 `../deepseek-harness` 後，應複製的是責任分界：

- generic HTTP server 不知道 Harness domain；
- daemon/browser 之間有正式 transport seam；
- connection management 負責 reconnect，session runtime 負責 projection；
- daemon 保有 session/run 真相，browser 保有選取與 draft；
- app shell 組合網站功能，而不是 import legacy portals。

不應複製 Cordis、動態 frontend package discovery、boot graph、slot registry 或 custom HMR。Mikan 現在只有一個 first-party Vite bundle；這些機制尚無第二個真實 adapter，因此只會增加 indirection。

## 採用的使用者流程

1. 使用者先在 private chat 執行 `/login web`，完成 GitHub admission binding。
2. `/login` 以 immutable GitHub numeric id 建立 24 小時 browser session。
3. 空狀態建立 New Conversation；每個網站 Conversation 都是 `platform = web` 的第一級 Conversation office。
4. Sidebar 選取 office，daemon 回傳其 current Harness Session UUID 與 transcript。
5. Prompt 帶 office key + Session UUID；daemon 回傳 run id 並以 SSE 推送 ordered events。
6. Cancel 再帶 run id，避免 stale tab 中止後來的 run。
7. Model／thinking level 透過既有 settings mutation seam 更新，只影響該 office 的下一個 runner。
8. Refresh 由 SessionStore snapshot 重建；reconnect 依 epoch/sequence replay，無法補齊就 resnapshot。
9. `/session`、`/admin`、`/link` 始終由 daemon portal handler 優先處理，不進 SPA fallback。

## 採用的系統

```text
React UI
  → HarnessClient (React-free projection + intents)
    → HarnessHostPort
      ├─ Http/SSE adapter
      └─ in-memory test adapter
        → MikanHarnessHost
          → synthetic web MessagingBot / ConversationResponder
            → existing ConversationRuntime
              → createRunner → MikanAgentSession
```

Wire contract 只有 bootstrap、object-rooted command union、ordered event envelope。Web host 以 HMAC owner digest + Office registry 驗證 OAuth principal 的 Web offices；不回傳 host path，也不建立第二份 Conversation inventory。

## 已移除的錯誤結構

- `packages/ui-session`
- `packages/ui-admin`
- `packages/ui-vault`
- `packages/web-bundle`
- `packages/daemon-web-bridge`
- `window.__MIKAN_BOOT__` 與 boot-manifest injection
- `/api/offices` 的 cookie → Session View capability translation
- Session/Admin/Vault routes inside `AppFrame`

詳細 invariant、failure behavior 與檔案責任請見 ADR 0007、`src/web/harness/README.md`、`packages/web-client/README.md`。
