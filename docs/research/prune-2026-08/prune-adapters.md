# `src/adapters/` 唯讀剪枝審計

範圍：`src/adapter.ts`、`src/adapters/` 全部 10,446 行，以及全 repo `rg` 交叉引用。未修改 repository 檔案。

## 優先結論

目前最大的正向訊號是：訊息 intake、分段、progressive rendering、附件落盤與 retry 核心已經上提到 shared，四平台並沒有四套完整實作。可剪枝的主要來源反而是：(1) 已被新介面取代但仍保留的相容分支；(2) concrete bot 暴露大量只供 context factory 使用的方法；(3) GitHub adapter 內混入非 GitHub conversation adapter 的 GCP/Cloud Build 子系統；(4) 少量只有測試引用的 exports/參數。

## 發現

### 1. deprecated error-reporting seam 已無任何 caller

- **檔案:行號**：`src/adapters/types.ts:113-119`、`src/adapters/progressive-renderer.ts:79-83`
- **問題**：`ProgressiveRendererPlatform.reportError` 已標示 deprecated；全 repo `rg '\breportError\b'` 只命中型別宣告與 renderer 的 fallback，四平台都已使用 `responseErrorContext`。這是已完成遷移後留下的雙介面與不可觸發相容分支。
- **建議動作**：刪除 `reportError` 欄位，以及 `createProgressiveRenderer` 中 `responseErrorContext` 不存在時呼叫 `platform.reportError?.(...)` 的 fallback。保留單一 `createChatResponseErrorReporter` 路徑。
- **預估省行數**：10–13 行
- **風險**：**safe**（repo 內零 caller；若視 npm 外部 consumers 為相容性承諾則升為 confirm）

### 2. `ChatAdapter` 是未實作、未使用、且與 `MessagingBot` 重疊的公開介面

- **檔案:行號**：`src/types.ts:206-210`、`src/adapter.ts:14`、`src/index.ts:180`
- **問題**：`ChatAdapter` 僅含 `start/stop/getMessagingInfo`；四個 bot 都直接 `implements MessagingBot`，repo 內沒有任何 `ChatAdapter` 使用者，只有兩層 re-export。它是淺介面，且 lifecycle 規則與 `MessagingBot` 存在兩份。
- **特別標記**：**同一規則存在 2 份會漂移**（`ChatAdapter` 與 `MessagingBot` 的 adapter lifecycle）。
- **建議動作**：從 `types.ts`、`adapter.ts`、`index.ts` 移除 `ChatAdapter`；以 `MessagingBot` 作唯一平台 seam。
- **預估省行數**：6–9 行
- **風險**：**confirm**（已由 `src/index.ts` 發佈，需確認 npm API 相容策略）

### 3. context factory 的回傳 contract 在四檔手寫四次，沒有使用平台中立型別

- **檔案:行號**：`src/adapters/slack/context.ts:13-22`、`discord/context.ts:25-34`、`telegram/context.ts:28-37`、`github/context.ts:10-19`
- **問題**：四個 `create*Adapters` 都重複宣告完全相同的 `{ address; message; responder; platform }` inline return type。`ConversationContext` 已由 `src/adapter.ts` re-export，卻未作為這四個 factory 的 authoritative contract；欄位若增減會逐平台漂移。
- **特別標記**：**同一規則存在 4 份會漂移**。
- **建議動作**：讓四個 factory 明確回傳既有 `ConversationContext`（若其 shape 完全一致）；若名稱語義不同，於最近的 `types.ts` 建立單一 authority，而非再加第五個 wrapper。
- **預估省行數**：24–32 行
- **風險**：**safe**（先由 TypeScript 驗證既有 shape）

### 4. 四平台 bot 都保留薄的 logging passthrough methods

- **檔案:行號**：`src/adapters/slack/bot.ts:719-742`、`discord/bot.ts:290-302`、`telegram/bot.ts:223-228`、`github/bot.ts:364-370`
- **問題**：`logToFile` 四份都只做 `conversationId -> Office -> appendChannelLog`；`logBotResponse` 四份都只轉呼叫 `appendBotResponseLog`（Slack 僅多 thread/blocks fields）。這些 public concrete-bot methods 幾乎沒有隱藏 SDK 複雜度，反而讓 context factories 必須依賴 concrete bot 內部能力，擴大平台 seam。
- **特別標記**：**同一規則存在 4 份會漂移**（channel log），以及 **4 份會漂移**（bot-response log）。
- **建議動作**：將 office-scoped logger 作為 context factory 的 shared implementation；Slack 只傳 extra fields。避免新增 base class；直接以 shared functions/閉包取代薄 methods。
- **預估省行數**：25–38 行
- **風險**：**confirm**（需選定 `Workspace -> Office` 的唯一 authority，避免讓 context 亂摸 workspace）

### 5. incoming attachment 的「失敗後 warning + saved mapping」在三平台重複

- **檔案:行號**：`src/adapters/discord/bot.ts:306-329`、`telegram/bot.ts:236-259`、`slack/bot.ts:1767-1797`
- **問題**：三平台都已使用 `saveIncomingAttachments`，但各自重複 `failed` 迴圈、warning 字串與 `saved.map({name: original, localPath})`。下載 mechanics 應平台化，但 outcome normalization 是同一規則；目前 warning wording 與 failure policy 已有漂移（Slack all-or-error，Discord/Telegram skip-and-warn），其中 skip-and-warn 的共同部分仍有兩份。
- **特別標記**：**同一 normalization 規則存在 3 份會漂移**；**同一 skip-and-warn policy 存在 2 份會漂移**。
- **建議動作**：保留各平台建構 `IncomingAttachment[]` 的部分；在 shared 增加小型 outcome finalizer，明確以 policy data 表示 `throw` 或 `warn-and-skip`，回傳 `Attachment[]`。不要上提 SDK download code。
- **預估省行數**：12–20 行
- **風險**：**confirm**（Slack 的 all-or-error 行為必須保持）

### 6. Discord attachment API 帶著從未使用的 `_messageId`

- **檔案:行號**：`src/adapters/discord/bot.ts:306-310`、caller `src/adapters/discord/bot.ts:639`
- **問題**：`processAttachments(..., _messageId)` 明確未使用；全 repo 只有單一 caller。它看似舊 filename/metadata 設計殘留，增加無效介面參數。
- **建議動作**：刪除參數及 caller argument。
- **預估省行數**：2 行
- **風險**：**safe**

### 7. 多個 symbols 只為測試而 export，擴大 production surface

- **檔案:行號**：`src/adapters/markdown-tables.ts:111` (`displayWidth`)、`github/client.ts:31` (`githubIsRateLimited`)、`slack/bot.ts:91` 附近 (`chunkStreamText`)、`slack/session.ts:17,21,33`、`slack/assistant.ts:237` (`summarizeTitle`)
- **問題**：全 repo reference scan 顯示這些 symbol 的 production 命中只在其定義檔內，額外 caller 只有 `src/test/`。其中多數是 implementation detail，export 僅為白盒測試服務，令 adapter 介面比真正 caller 所需更寬。
- **建議動作**：優先透過 public behavior 測試並移除 export；若純函式確實值得獨立 authority，才移到現有合適 shared module，勿建立一函式一檔。
- **預估省行數**：0–8 行（主要收益是縮小介面；測試重寫後可能刪除 test scaffolding）
- **風險**：**confirm**（部分可能被未納入 repo 的 embedders 使用）

### 8. GitHub conversation adapter 內含完整 GCP ADC/OAuth client，超出 adapter seam

- **檔案:行號**：`src/adapters/github/gcp-auth.ts:1-282`、`cloudbuild.ts:1-100`、整合點 `github/github-ops.ts:1-12, 280-360` 附近、`src/main.ts:782-790`
- **問題**：為讀取 Google Cloud Build log，GitHub adapter 自行實作 external-account STS、service-account JWT、authorized-user refresh、token cache 與 Cloud Build API。這 382 行不是 GitHub SDK adaptation，也不是 conversation core；它使 GitHub adapter 同時成為第二個雲端身分/API client。對「每平台 SDK 包裝層是否過厚」而言，這是最大宗。
- **建議動作**：確認 Cloud Build log 是否仍是核心需求。若不是，刪除 optional integration，保留 checks summary/details URL；若是，移至獨立 infrastructure module，由 GitHub ops 注入窄的 `getBuildLog` capability。不要在 adapter 內繼續擴充 ADC client。
- **預估省行數**：**confirm-remove：330–390 行**；僅移出 adapter：adapter 目錄可少 360+ 行但總 repo 行數幾乎不變
- **風險**：**confirm**（會影響啟用 `GOOGLE_APPLICATION_CREDENTIALS` 的 Cloud Build log 功能）

### 9. GitHub webhook 路由讓 web server 直接 import concrete adapter internal

- **檔案:行號**：`src/web/server.ts:20-24, 39-40, 66-71`、`src/adapters/github/webhook.ts:60-101`
- **問題**：平台中立 web server 直接 import `adapters/github/webhook.ts`，繞過 `src/adapter.ts` seam。Webhook 本身只是「poke poller」，屬 transport/web ingress，不是 `MessagingBot` capability；目前 concrete adapter internal 已滲入 web module。
- **建議動作**：由 composition root 注入一個窄 request handler，或將 webhook route 的 authority 移到 web ingress slot；server 不應知道 GitHub adapter 檔案。若 webhook 使用率低，可確認後整項刪除（polling 已是 backstop）。
- **預估省行數**：重排 seam 約 0–8 行；若確認刪除 webhook則 85–105 行
- **風險**：**confirm**

### 10. Office registry 反向依賴 GitHub adapter 的 ID parser

- **檔案:行號**：`src/office/registry.ts:20`（import `../adapters/github/ids.js`）；authority 現址 `src/adapters/github/ids.ts:1-63`
- **問題**：核心 office identity module 直接依賴 concrete GitHub adapter internal。這是 adapter.ts seam 的反向繞過，也讓 GitHub conversation-id grammar 同時承擔 office migration/registry 規則。未來 adapter 拆除或重命名會波及核心 registry。
- **建議動作**：把跨模組需要的 conversation-id grammar 放到平台中立 identity authority（或由 registry 使用 OfficeAddress/registry data，不解析 concrete platform id）；adapter 再依賴該 authority，不能反向。
- **預估省行數**：0–6 行（主要收益是依賴方向與介面強度）
- **風險**：**confirm**（identity/migration 行為需完整回歸）

### 11. 四個 context factory 重複 session fallback，但 Slack 已另有獨立 authority

- **檔案:行號**：`discord/context.ts:40-49`、`github/context.ts:24-33`、`telegram/context.ts:43`、`slack/context.ts:22-25` + `slack/session.ts:17-85`
- **問題**：平台 context 都負責決定 session key，但使用三種入口：Discord/GitHub inline 呼叫 `resolveChatSessionKey`、Telegram `deriveSessionKey`、Slack 再經完整 `planSlackAdapterSession`。差異有合理平台語義，但「factory 必須自行 fallback」這條規則分散，且 Discord/GitHub 已是逐字同構。
- **特別標記**：**同一 fallback 規則存在 2 份會漂移**（Discord/GitHub）；更高層 session-plan responsibility 存在 4 處。
- **建議動作**：至少抽掉 Discord/GitHub 的同構 block，直接以既有 `deriveSessionKey(event)`（若語義相同）作唯一 authority；Slack 特殊規則留在 `session.ts`，不要強行泛化。
- **預估省行數**：12–18 行
- **風險**：**safe**（前提是 `deriveSessionKey` 對兩平台輸出由測試證明相同）

### 12. Retry wrapper 的樣板存在四份，但不值得建立新的 wrapper 檔

- **檔案:行號**：`slack/bot.ts:103-104`、`discord/bot.ts:62-63`、`telegram/bot.ts:36-37`、`github/client.ts:41-42`
- **問題**：四平台都定義兩行的 `<platform>Retry = withRetry(fn, { isRateLimited })`。這是 **同一規則存在 4 份會漂移**，但每份只綁定平台-specific predicate；目前真正 backoff authority 已在 `shared.withRetry`，漂移面很小。
- **建議動作**：不要為此新增檔案或 class。可在 `shared.ts` 提供 `bindRetry(isRateLimited)` 並刪四份樣板；若省行不足以抵銷新 abstraction，維持現狀反而較好。這項是低優先剪枝候選，不應先做。
- **預估省行數**：淨 2–5 行
- **風險**：**safe**，但收益低

## 不建議剪的區域

- `src/adapters/progressive-renderer.ts` 雖有 557 行，但它已是四平台共用的單一 rendering authority，刪除它會讓大量狀態機複製回各 adapter；依 File-Split Scale 屬於 **Authority + Weight**。
- `src/adapters/intake.ts` 已集中 magic word、trigger、attachment、busy、queue、dispatch 的順序，屬於明確 authority。
- `src/adapters/markdown-tables.ts` 同時服務 Slack Block Kit 與 Discord markdown conversion；不應把 table parser 再拆小。
- `src/adapters/github/client.ts` 的 GitHub REST methods 多為實際平台 slot；可縮窄 exports，但不應再包一層「repository/service」薄 wrapper。

## 建議執行順序

1. **safe 小剪枝**：deprecated `reportError`、Discord `_messageId`、context return type 去重。
2. **介面收斂**：移除/棄用 `ChatAdapter`、縮窄 test-only exports、消除 concrete bot logging passthrough。
3. **規則單一化**：Discord/GitHub session fallback、attachment outcome normalization。
4. **需產品確認的大剪枝**：Cloud Build/GCP auth、GitHub webhook。
5. **架構修正**：office registry 不再反向 import GitHub adapter internal。

保守估計：不移除任何 optional feature 時可淨減約 **70–120 行**；若確認 Cloud Build integration 與 webhook 都可移除，總量約可減 **480–610 行**。
