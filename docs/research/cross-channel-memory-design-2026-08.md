# Cross-Channel Memory Design — 跨頻道學習

**日期**: 2026-08-28
**狀態**: 已實作（core mechanism + prompt guidance + chat/admin 控制面，見本文件尾部「實作紀錄」）
**背景**: 對標 Anthropic Claude Tag 的「Learns over time」能力（跟隨頻道累積脈絡，
且經授權可跨頻道自動學習，但不從私有頻道回報）。mikan 目前只有單頻道記憶
（`MEMORY.md`），這份文件記錄怎麼把 Claude Tag 已驗證的記憶模型對齊進 mikan。

## 為什麼不需要再開一輪模型辯論

Round 1–6 花了大量篇幅討論「office group」該怎麼設計——顯式加入群組、雙邊 vault
授權、唯讀 mount + host API 並發控制——試圖解決「怎麼讓互相信任的 conversation 共享
知識，又防止單邊拉群偷資料」這個問題。這條路線後來被判斷問錯了問題（IM 平台上的
agent 互動維持現狀，不需要多 conversation 共同寫入一份檔案），整套技術結論作廢。

Claude Tag 的官方文件直接給出了一個已經在生產環境驗證過的更簡單答案：**共享範圍不是
額外授權出來的，是頻道本身「public/private」這個既有屬性自動決定的**。不需要「拉群」
這個動作，也不需要雙邊同意流程——這正是 Round 1–6 一直沒能收斂的問題，Claude Tag
用一個更小的模型解決了。

## Claude Tag 的記憶模型（引用整理）

```
Public 頻道  ←→ Workspace Memory（全 workspace 共享，自動雙向讀寫）
Private 頻道 →  只能讀 Workspace Memory（唯讀）+ 寫自己的 channel store（不外流）
DM          →  完全獨立，存在 workspace 底下但不屬於任何 channel/使用者帳號
```

原文關鍵規則：

- "Memory from public channels is shared across the workspace... What it learns
  working in a private channel is saved to that channel's own store."
- "Private channels **read workspace memory while working**, and what they save is
  written to that channel's own store rather than the workspace store."
- "If a public channel is later made private, what Claude saved to workspace
  memory while the channel was public **stays in workspace memory**... If those
  earlier entries shouldn't stay shared, ask an Owner to delete them."
- "Memory is a curated note, not a transcript... memory works best holding stable
  facts, not a running log of events."
- "Anyone in the channel can read and change channel memory" — 訂正/遺忘是顯式、
  對話式的操作，不是系統自動維護。

## mikan 現況：已有地基，但模型不對齊

mikan 已經有做同一件事的機制雛形，不是從零開始，但跟 Claude Tag 比有三處實質落差。

### 現有機制（`src/workspace-projection/`、`src/types.ts`）

```ts
type WorkspaceDoorPolicy = "isolated" | "trusted";
type WorkspaceLayout = "conversation" | "shared-support" | "full";
```

- `isolated` + `conversation`：完全隔離，agent 只看得到自己 office 的 `MEMORY.md`。
- `trusted` + `shared-support`：額外掛載 workspace 層級的全域 `MEMORY.md`、
  `skills/`、`events/` 進 sandbox（`/workspace/MEMORY.md` 等），**讀寫皆可**。
- `trusted` + `full`：整個 workspace root 掛進 sandbox，等於直接看到其他
  conversation 的目錄。

`getMemory()`（`src/agent/prompt.ts`）在有 `globalMemoryPath` 時，會把 workspace
全域記憶跟 conversation 自己的記憶都塞進 prompt，兩者並列，沒有主從或讀寫不對稱。

### 三個落差

1. **雙向讀寫，沒有 public/private 不對稱**。任何被設成 `trusted` 的 conversation
   都能**寫**全域 `MEMORY.md`（`shared-support` 直接把 `workspace.memoryPath` 掛
   進 sandbox 當普通檔案，agent 用 `write`/`edit` 工具就能改）。Claude Tag 的
   private 頻道只能讀、不能寫，mikan 目前沒有這個防線——一個被標記 trusted 的
   private 頻道，一樣可以把內部資訊寫進全域記憶外流給其他頻道。

2. **共享範圍是 admin 手動配置的 boolean，不是頻道公開/私密這個自然屬性自動決定
   的**。`doorPolicy` 要 admin 主動把每個 conversation 設成 `trusted`，不像
   Slack 頻道本身自帶「這是 public 還是 private」的屬性可以直接借用。這代表在
   mikan 裡，「要不要參與共享」目前是一次性、需要人工介入的決策，而不是隨頻道屬性
   自動生效/自動排除。

3. **沒有策展機制**。`MEMORY.md` 是一份被 agent 用檔案工具直接寫的純文字檔，
   沒有「remember for this channel: ...」這種顯式指令介面，沒有「what do you
   remember」查詢介面，沒有訂正/遺忘的對話式操作。品質完全依賴 agent 自律，容易
   累積成一份長期沒人整理、逐漸失真的檔案。

## 建議設計：對齊 Claude Tag 的三檔模型

### 1. 引入 conversation 可見度屬性，替代/擴充現有的 `doorPolicy`

不新增「office group」這種要顯式加入的概念，改成給每個 conversation 一個可見度
屬性，盡量借用平台本身已有的公開/私密語意：

```
visibility: "public" | "private" | "isolated"
```

- **`public`**：對應 Slack public channel / Discord 公開頻道等。自動加入
  workspace 共享池——讀寫全域 workspace memory。
- **`private`**：對應 Slack private channel、DM 群組等。只讀 workspace memory，
  自己學到的東西寫進 conversation 自己的 `MEMORY.md`，不外流。
- **`isolated`**：完全不參與共享，讀寫都侷限在自己的 `MEMORY.md`（等同現有的
  `isolated` + `conversation` 佈局，維持現狀作為預設安全值）。

`isolated` 保留是必要的：不是所有平台的 conversation 都有清楚的 public/private
語意（例如 GitHub issue、Telegram 私聊），対這些場景，`isolated` 仍是合理的預設，
需要 admin 明確選擇升級到 `public`/`private` 才參與共享。

### 2. Workspace memory 的讀寫改成非對稱

`shared-support` 佈局目前把 `workspace.memoryPath` 當一般檔案掛進 sandbox，agent
自己的 `write`/`edit` 工具就能改。要做到 Claude Tag 的「private 頻道只讀」，寫入
全域記憶需要走一個窄介面，不能是任意檔案寫入：

- `public` conversation：workspace memory 掛可讀寫（維持現有 `shared-support`
  行為，但只對 `public` 開放）。
- `private` conversation：workspace memory 掛**唯讀**（bind mount 唯讀 / chmod
  444，比照 Round 6 討論過的「唯讀 mount 防寫壞」機制，這裡终于有真正對得上的
  用途），自己的 `MEMORY.md` 維持現有讀寫。

這跟 Round 6 的並發控制設計不同：Round 6 是為了解決「多個 agent 共同編輯一份檔案」
的並發問題（後來判定問錯問題作廢）；這裡唯讀是為了**防止資訊單向外流**，是存取控制
問題，不是並發問題，機制形狀類似（唯讀掛載）但目的不同，值得記錄以免將來混淆。

### 3. 策展介面：讓記憶可被查詢、訂正、遺忘

不需要新的資料結構，`MEMORY.md` 仍是純文字檔，但 agent 的 prompt/skill 裡要新增
對應這三個操作的指引：

- **查詢**：使用者問「記得這個頻道的哪些事」時，agent 直接讀 `MEMORY.md` 內容
  逐條列出，不需要額外索引。
- **訂正/遺忘**：使用者說「忘記/修正 XX」時，agent 用既有的 `edit` 工具移除/更新
  對應段落——這已經是現有能力，缺的只是要不要在 `agent/prompt.ts` 的系統提示裡
  明確教它「這是被期待的操作，不是異常請求」。
- **策展原則寫進系統提示**：比照 Claude Tag「memory works best holding stable
  facts, not a running log of events」，明確要求 agent 寫入 `MEMORY.md` 前先
  判斷「這是穩定事實還是流水帳」，避免記憶檔案退化成聊天記錄的複本。

### 4. 可見度變更時的資料處置：比照 Claude Tag 的「不可逆共享 + 手動清理」

- `private`/`isolated` → `public`：conversation 開始寫入 workspace memory；此前
  它自己 `MEMORY.md` 累積的內容**不會自動搬進去**，除非 agent 或 admin 主動執行
  一次性的「promote to workspace memory」操作。
- `public` → `private`/`isolated`：此前它已經寫進 workspace memory 的內容
  **留在原地**，其他 conversation 繼續讀得到，不會自動撤回。需要撤回的話，
  admin 必須手動去 workspace 全域 `MEMORY.md` 裡刪除對應段落。

這條規則刻意選擇跟 Claude Tag 一致（不做自動追溯清理），理由：

1. 自動追溯清理需要追蹤「這條記憶是哪個 conversation 寫的」，`MEMORY.md` 目前是
   無結構純文字，做這件事需要引入結構化的來源標記，複雜度顯著上升。
2. 已經被其他 conversation 讀取、可能已經影響過往決策的資訊，事後自動撤回本身
   語意就模糊（撤回訊息本身，還是撤回訊息造成的後續影響？）。
3. Admin 手動清理是保守但誠實的預設：不假裝系統能做到自動化的資訊撤回。

## 不採用的部分（跟 Claude Tag 比，刻意不對齊）

- **Service account 憑證模型**（Claude Tag 用專屬服務帳號執行頻道任務，跟真人憑證
  完全分離）：這塊屬於 vault/憑證設計，不是記憶設計，另案處理，不在本文件範圍。
  但值得記錄：Round 1–8 討論的「vault 雙邊顯式授權」可能問錯了方向，Claude Tag 的
  真實答案更接近「大家共用一個 admin 配置的服務身份」，不是「使用者互相授權彼此的
  個人憑證」——這點留給 vault 設計另開文件處理。
- **workspace 內搜尋（"Claude can search the web... workspace search"）**：mikan
  目前沒有等價的全 workspace 關鍵詞搜尋能力，這屬於獨立的功能缺口，不在本文件
  討論的記憶模型範圍內。

## 小結：跟現有機制的落差是三個具體改動，不是重新設計

1. `WorkspaceDoorPolicy`/`WorkspaceLayout` 的二元 `isolated`/`trusted` 配置，
   擴充或替換成三檔 `visibility: "public" | "private" | "isolated"`。
2. `shared-support` 佈局的 workspace memory 掛載，依 `visibility` 決定唯讀
   （`private`）或讀寫（`public`），不再是單一寫死的讀寫掛載。
3. `agent/prompt.ts` 的系統提示補上「記憶是策展筆記，不是流水帳」+「查詢/訂正/
   遺忘是被期待的正常操作」的指引，不需要新的資料結構或工具。

## 實作紀錄（2026-08-28）

本設計的三項小結已實作並通過測試：

1. **`WorkspaceVisibility`**（`src/types.ts`）新型別 `"public" | "private"`，加入
   `WorkspaceSettings.visibility`（選擇欄位，未設定預設 `"public"`）。**這裡沒有新增
   `"isolated"` 第三檔**，因為現有 `WorkspaceDoorPolicy`（`isolated`/`trusted`）已經擔了
   這個角色：`isolated` 就是完全不參與共享的那一檔，`visibility` 只在
   `doorPolicy: "trusted"` 下才有意義（既存型別 `WorkspacePolicyChoice` 本來就把
   `layout` 鎖在 `trusted` 分支底下，`visibility` 當然一併）。
2. **`resolveWorkspaceProjection`**（`src/workspace-projection/index.ts`）新增
   `globalMemoryReadOnly` 計算：只有 `layout === "shared-support"` 且
   `visibility === "private"` 時，`workspace/MEMORY.md` 的 `ContainerMount` 才帶
   `readOnly: true`。`full` layout 仍然是一個讀寫 bind，沒有分離的 memory 檔可管；
   `skills/`、`events/` 不受影響，仍然讀寫。既有的 `readOnly` 機制（`ContainerMount`）
   本來就存在，且 container/image 後端已經會尊重它（Docker `:ro` 線回），
   **本設計並未發明新的強制機制，只是使用現有的**。（更新：gondolin/firecracker
   後端已於 2026-08-28 整個移除，不再需要維護它們的掛載語意。）
3. **`agent/prompt.ts`**：`memoryGuidance` 新增 visibility-aware 分支——private
   時明確告訴 agent「寫入共用 MEMORY.md 會被拒絕，請寫進自己的 conversation
   MEMORY.md」；Memory 節新增「策展筆記、不是流水帳」+「查詢/訂正/遺忘是正常要求」的
   提醒。

既有初設計的伏筆裡還有兩點已在實作這輪一併展開，不需要再等後續。

### 控制面：`/pi-sandbox door`（聊天指令）+ admin portal

- `/pi-sandbox door <default|isolated|shared|shared-private|full>`：新增
  `shared-private` 選項（並且 `shared`/`shared-support` 明確別名為 `shared-public`），
  狀態顯示行並列出 `doorPolicy / layout / visibility` 三個值。
- Admin portal（`src/web/admin/portal.ts`）：新增 `trusted-shared-support-private` 選項
  （對應 conversation 的 `/admin/api/conversations/sandbox` 和 global 的
  `/admin/api/settings/workspace`），並在 UI 上用人讀描述提醒共用 MEMORY.md 只讀。
- **這裡選擇直接擴充現有的 door-policy 選擇面，不新建獨立的 visibility 控制面**，因為
  visibility 只對 `shared-support` 有意義，跟 door policy 本質就是一體的選擇，分開
  成兩個控制面只會讓使用者面對不存在的組合（例如 `layout: "full"` +
  `visibility: "private"`）。

### 未解決的已知缺口（意圖保留，非實作疏失）

- **Host 模式下沒有具體強制力**：`readOnly` 只對會 bind mount 的後端（container/image）
  有核心強制力（內核拒寫）。Host、Cloudflare 執行後端不
  讀取 `WorkspaceProjection.mounts`（見 `execution-resolver.ts` 的
  `resolveSandboxConfig`），對這些後端而言，private visibility 只是 prompt 層的
  提醒，**不是硬邊界**。已在 `workspace-projection/index.ts` 的註解註明這個
  限制，但未提供 host 模式下的執行層強制（例如 chmod 444）——這項不在本次實作
  範圍內，若需要封閉 host 模式的完整安全邊界，需另外設計。
- **不同平台的 public/private 自動判別**：本次實作仍然是手動選擇（透過指令/admin
  選選項），並未自動將 Slack public channel 對應成 `visibility: "public"`、private
  channel 對應成 `"private"`。這項自動推導未在本次實作範圍內。
- **策展介面僅止於 prompt 指引**：查詢/訂正/遺忘目前依賴 agent 自己讀寫 `MEMORY.md`
  檔案完成，未新建專用的工具或結構化資料。

### 測試覆蓋

- `src/test/workspace-projection.test.ts`：新增 4 個測試涵蓋 public 預設行為、
  private 唯讀掛載、`full` layout 下 visibility 無效、conversation override 覆蓋
  global 預設。
- `src/test/sandbox-command.test.ts`：新增 `shared-private` 參數解析測試。
- `src/test/commands.test.ts`：更新既有 door 相關測試以反映新增的 visibility 顯示，
  新增 `shared-private` 寫入測試。
- `src/test/agent-prompt.test.ts`：新增 3 個測試涵蓋 public/private 的
  `memoryGuidance` 分支與策展提醒文字。
- 全套 `npm test`：120 test files、1777 tests 全數通過。`npm run build`、
  `npm run lint`、`npm run fmt:check`、`npm run knip` 全數乾淨。

## 未決問題

- `visibility` 屬性要放在哪一層配置——比照現有 `sandbox.workspace.doorPolicy` 放
  在 `resolveConversationSettings` 底下，還是需要獨立的欄位？
- 不同平台的「public/private」語意怎麼對應：Slack channel 有明確的
  public/private 屬性可以直接借用；Discord、Telegram、GitHub 的對應關係需要
  分別定義，預設值該是什麼（保守預設可能是全部 `isolated`，需要 admin 顯式升級）。
- Workspace memory 唯讀掛載的具體實作機制（bind mount 唯讀 vs chmod）要對照
  mikan 現有 sandbox 各執行後端（host/container/cloudflare）
  分別驗證可行性，不是所有後端都用同一種掛載方式。

## 附錄：資料來源

本文件基於 Anthropic Claude Tag 官方文件（2026-08-28 由使用者提供全文，非模型
推測），對照 mikan 現有原始碼（`src/workspace-projection/`、`src/types.ts`、
`src/agent/prompt.ts`）整理而成。不同於 Ambient 設計文件，本文件未經過多模型
交叉討論，因為官方文件已提供足夠具體、已在生產環境驗證的答案，判斷不需要再開一輪
發散討論。
