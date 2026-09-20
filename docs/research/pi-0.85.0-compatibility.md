# Pi 0.85.0 變更與 mikan 相容性評估

調查日期：2026-09-20  
評估基線：mikan 從 `@earendil-works/pi-agent-core` / `pi-ai` `^0.84.3` 升到 `^0.85.0` 的實際路徑；另核對目前 `main` 的 `0.86.0` 狀態。

## 結論

**若從 mikan 當時的 Pi 0.84.3 直接升到 0.85.0，屬高風險、不相容升級。** 最大原因不是 release 頁面醒目列出的模型或工具修正，而是發布套件中的 `pi-agent-core` harness 與 session storage contract 已大幅改寫：lane 操作改為 `accept` / `drive` / `requestAbort` 並普遍要求 `Context`，JSONL header 與 mutation schema 也改變。既有 0.84 session 不可直接由新版開啟，harness 呼叫端亦必須改造。[U1][U3][U4][U5][M1][M2]

**目前 `main` 已完成核心緩解，並已再升至 Pi 0.86.0。** mikan 已加入離線 session migration、舊格式 early error、native `AgentHarness` 串接、取消與恢復測試；本次相關單元測試全數通過。殘餘風險集中在真實 provider 的 reasoning replay、proxy、host/container 相對路徑，以及 mikan 對 `pi-agent-core` low-level exports 的高度耦合。[M1][M2][M3][M4][M5]

## 來源身分與調查方法

- 官方 GitHub `v0.85.0` release 發布於 2026-09-04，tag/發布 commit 是 `107d79f11072bbc8a3a757ed7fd69596bee7d68c`。[U1][U2]
- npm 上 `pi-agent-core@0.85.0`、`pi-ai@0.85.0` 與 `pi-coding-agent@0.85.0` 的 `gitHead` 均是同一 commit；本次直接解開發布 tarball，核對其 `dist/*.d.ts`、package exports 與 changelog，而非只讀 release 摘要。[N1][N2][N3]
- 上游差異以 mikan 升級前實際版本 `0.84.3` 對 `0.85.0` 比較。[U3]
- mikan 不依賴 `pi-coding-agent`，直接依賴 `pi-agent-core` 與 `pi-ai`；因此 coding-agent 的 TUI、session share/import 等項目只在共用底層變更可能外溢時才相關。[M5]

> 注意：官方頂層 release notes 是整個 monorepo 的使用者摘要；package changelog 才是各套件宣告的 API 記錄。然而 `pi-agent-core` 0.85.0 changelog 只列 thinking level 與 write count 兩個 fix，沒有充分揭露 tarball 中可觀察到的 harness/session contract rewrite。因此此版本不能只靠 release notes 或 semver minor 判斷相容性。[U1][U4][N1]

## 逐項變更與影響

| 變更                                                                                                                                                                                                                                                                          | 第一手證據                                                                        | mikan 實際使用點                                                                                                                                                                                                      | 判定與風險                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`pi-agent-core` harness 大幅改寫**：相較 0.84.3，0.85.0 的公開 declarations 從 scaffold/outcome API 轉為 durable runtime；lane 提供 `accept`、`drive`、`requestAbort`，且 lane/harness query、mutation 普遍新增 `Context`。events、hooks、result 與 snapshot types 亦改變。 | 上游 source/tag compare 與發布 tarball declarations：[U3][U5][N1]                 | mikan 目前直接呼叫 `lane.accept/drive/resume/requestAbort`、傳入 `TODO_CONTEXT`，並註冊 typed hooks/events：[M3]                                                                                                      | **高風險、breaking。** 當時需大幅改造 runner；實際 commit `192c47c` 變更 1,234 additions / 495 deletions並新增 native/cancellation tests，證實不是無感升級。[M4]                                  |
| **JSONL v4 storage schema 改變**：header 從 `{kind:"header", version:4}` 改為 `{v:4, kind:"header", storageVersion:1}`；storage mutation/state 也改為新版 entry/value/list/transaction contract。                                                                             | 0.84.3→0.85.0 `jsonl/types`、session source 與 tarball declarations：[U3][U6][N1] | mikan 明確辨識並拒絕 legacy v3 / Pi 0.84 v4 header，要求先執行 migration；migration 轉換 message、compaction、branch summary、custom entry，並保存舊 model/thinking/tools change 為 namespaced custom entry：[M1][M2] | **高風險、資料不相容。** 未遷移的既有 session 不能啟動。現有 offline migration、備份/驗證流程與 early error 已降低風險，但部署升級順序仍必須先遷移再啟動新版。                                    |
| **Anthropic per-turn effort 持久化與 signed-thinking mismatch recovery**；assistant message 增加可持久化 provider thinking level/frame。                                                                                                                                      | `pi-ai` changelog、Anthropic transport/types 與官方 release：[U1][U7][U8]         | mikan 在 run 前先解析 auth，之後由 native harness 接收事件並持久化完整 message；沒有另行剝除 thinking metadata：[M3]                                                                                                  | **中風險、方向正向。** 單元 faux provider 無法證明真實 Claude/OpenRouter 的 signed-thinking replay；應做 mid-conversation reasoning + session resume smoke test。                                 |
| **`pi-ai` 唯一明示 breaking change**：Cloudflare Workers AI binding helper 由 `createGatewayBindingFetch()` 改為 `createAiBindingFetch()`。                                                                                                                                   | `pi-ai` 0.85.0 changelog與新/舊 source：[U7][U9]                                  | repo 沒有使用這兩個 binding helper；Cloudflare sandbox 與 provider binding API 是不同介面。[M5]                                                                                                                       | **無直接影響。** 未來若加入 Workers AI binding transport，不能沿用舊 helper 名稱/語意。                                                                                                           |
| 新增 OpenAI-compatible `vllmPriority`、`supportsMaxOutputTokens`；新增較窄的 `api` / `providers` / `utils` subpath exports。                                                                                                                                                  | `pi-ai` changelog、types/package exports：[U7][U10]                               | custom `models.json` 的 `compat` 會原樣轉交；mikan 也直接使用 built-in catalog 與 lazy provider subpaths：[M6]                                                                                                        | **低至中風險。** 新 flags 可透過 raw `compat` 使用，但 mikan 沒有 top-level typed convenience field。subpath/export 或 catalog 後續再變動會直接影響編譯與 `/model` 結果。                         |
| Provider stream/event 修正：simple stream 標準事件序列、custom tool-call delta、Codex terminal SSE、Copilot Claude adapter、Fireworks/Baseten/Qwen/xAI catalog 修正。                                                                                                         | 官方 release與 `pi-ai` changelog/source compare：[U1][U3][U7]                     | mikan 透過 `Models`、lazy adapters 與 native harness 消費 stream/events，並把 tool lifecycle 映射為平台事件：[M3][M6]                                                                                                 | **中風險、主要是正向修正。** stream 序列改變可能暴露 presenter/harness 對事件順序的隱含假設；代表 provider 與 tool call 應各做一次 smoke test。catalog 移除 Grok Build 0.1 會改變可選模型。       |
| `bash/edit/find/grep/ls/read/write` 修正為遵守 `ctx.cwd`。                                                                                                                                                                                                                    | 官方 release與修正 PR/source：[U1][U11]                                           | mikan 的 Pi read/write/edit/bash tools 綁到 sandbox `ExecutionEnv`；bash 另明確把 `execution.cwd` 設為 runtime env cwd。container/cloudflare 相對路徑由 workspace root resolve：[M7][M8]                              | **中風險、預期行為修正。** 先前若意外依賴 process cwd，升級後路徑會移動。應 smoke-test host/container/cloudflare 的相對 read/write/edit/bash；特別注意 host env 現在以 `process.cwd()` 建立。[M8] |
| write tool 移除誤稱為 bytes 的 UTF-16 code-unit count。                                                                                                                                                                                                                       | agent changelog、官方 issue/source：[U1][U4][U12]                                 | mikan 只一般化轉送 tool result，未搜尋到 `Successfully wrote … bytes` 或 byte count parser；tool end 直接轉送 `event.result`。[M3][M5]                                                                                | **低風險。** 僅顯示文字改變；不要新增依賴該字串的 parser/snapshot。                                                                                                                               |
| `NO_PROXY` root/subdomain matching 修正；plain HTTP proxy 在 tool call 後改以 CONNECT，避免 hang。                                                                                                                                                                            | 官方 release、`pi-ai` changelog與 proxy source/tests：[U1][U7][U13]               | mikan 自己安裝 undici `EnvHttpProxyAgent` 與 global fetch，另由 Pi provider transport處理請求：[M9]                                                                                                                   | **中風險、方向正向。** 有雙層網路設定面；應在實際 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 部署做串流 + tool-call 後續請求測試。                                                                 |
| `SessionManager.inMemory()` 可從外部 entries 恢復；coding-agent 另有 session share/import/fork、TUI、managed tools 等修正。                                                                                                                                                   | 官方 release與 coding-agent changelog：[U1][U14]                                  | mikan 不依賴 `pi-coding-agent`，自己的 session backend 是 `pi-agent-core` `JsonlSessionRepo` / `MemorySessionRepo`。[M1][M5]                                                                                          | **無直接影響。** 不應把 coding-agent 的「restorable in-memory sessions」誤認為 mikan 所用 core session schema 的相容保證。                                                                        |

## mikan 已落地的緩解

1. **依賴與 session migration**：`aca419e` 把 `0.84.3` 升到 `0.85.0`，同時加入 Pi 0.84→0.85 的離線轉換、CLI 文件與測試。[M2][M4]
2. **native harness adaptation**：`192c47c` 將執行委派給新版 `AgentHarness`，涵蓋 admission/drive、恢復、取消、事件與 hooks。[M3][M4]
3. **後續 patch 與 current main**：`b811b49` 升到 0.85.1；目前 `package.json`/lock 已是 0.86.0（commit `9c6e38d`）。因此本報告的「高風險」描述的是 **0.84.3→0.85.0 升級邊界**，不是宣稱目前 main 尚未適配。[M4][M5]
4. **失敗要早且可操作**：新版 runtime 遇到舊 header 會直接指出 `mikan sessions migrate`，避免讓 Pi 用錯 schema 部分載入後才損壞資料。[M1]

## 殘餘風險與建議 gate

| 優先度 | 建議                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 升級/回滾 runbook 明訂：停止 writers → 備份 → `mikan sessions migrate` → 驗證 → 啟動；不要讓 0.84 與 ≥0.85 同時寫同一 session。                                     |
| P0     | 將 `pi-agent-core` 視為高耦合依賴；每次 minor upgrade 都要比較 npm tarball `dist/*.d.ts`、session header/mutations 與 package changelog，不只看頂層 release notes。 |
| P1     | 加入真實 provider smoke tests：Anthropic/OpenRouter thinking effort，含 tool call、session resume、歷史 reasoning replay。                                          |
| P1     | 加入 proxy smoke tests：`HTTP_PROXY`、`HTTPS_PROXY`、root/subdomain `NO_PROXY`，並覆蓋 tool call 後的下一次 provider request。                                      |
| P1     | 加入 host/container/cloudflare 相對路徑 smoke tests，覆蓋 read/write/edit/bash 的 cwd。                                                                             |
| P2     | 對 built-in catalog 與代表性 lazy provider subpath 做 snapshot/compile gate，及早發現模型移除、adapter 或 exports 改名。                                            |

## 驗證

初次調查時執行：

```text
npm test -- src/test/migrate-pi-084.test.ts src/test/harness-native.test.ts src/test/model-registry.test.ts src/test/execution-env.test.ts
```

結果：**4 files / 25 tests passed**。這證明 repo 內 migration、native harness、model registry 與 execution env 的既有測試通過；不等同真實 provider、proxy 或 container E2E。

## 後續：依殘餘風險補測試，並發現兩個實際 bug

依上表 P1/P2 建議，針對四個 seam 補了不需憑證、可在 CI 穩定執行的整合測試（不呼叫付費 provider、不需真實 Cloudflare/container）：

1. **`MikanAgentSession`／`SessionStore` 的 thinking effort 持久化**（`src/test/harness-native.test.ts`）：新增測試驗證 `providerThinkingLevel`（0.85.0 pi-ai changelog 修正項）在 close/reopen 後仍保留在持久化的 assistant entry 上。目前 Pi 版本下此測試直接綠燈；已用 mutation-testing 方式（暫時改斷言值）確認測試在回歸時會真正變紅。
2. **`configureHttpDispatcher` 的 proxy 行為**（`src/test/harness-http.test.ts`）：新增以真實本機 HTTP server／forwarding proxy 驗證 `HTTP_PROXY` 生效轉發，以及 `NO_PROXY` 對 root domain 的排除；不再只驗證 dispatcher 是 `EnvHttpProxyAgent` 的 instance。
3. **`createSandboxExecutionEnv` 的 host/container 相對路徑**（`src/test/execution-env.test.ts`）：新增測試驗證 host sandbox 下相對路徑以 `runtimeWorkspaceRoot` 解析，不受 mikan process 自身 `process.cwd()` 影響。**此測試首次執行即為紅燈，抓到下方的實際 bug**。
4. **model catalog gate**（`src/test/model-registry.test.ts`）：新增測試鎖定 onboarding 預設模型（`anthropic/claude-sonnet-4-6`，見 `src/settings/index.ts` 的 `ONBOARD_SETTINGS`）與 `src/harness/models.ts` 用到的六個 `@earendil-works/pi-ai/api/*.lazy` subpath 都仍存在；用暫時改壞模型 id 的方式確認此 gate 真的會在對應項目消失時失敗。

### 發現並修正的兩個實際 bug

| Bug                                                | 位置                                                       | 症狀                                                                                                                                                                                                                                                                                                                                                                                                                                  | 修正                                                         |
| -------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| host sandbox 忽略 `runtimeWorkspaceRoot`           | `src/harness/execution-env.ts` `createSandboxExecutionEnv` | `sandboxType === "host"` 分支建立 `NodeExecutionEnv({ cwd: process.cwd() })`，完全忽略呼叫端 `src/harness/runner.ts` 傳入的 `runtimeWorkspaceRoot`（對話的 workspace 目錄）。model 用相對路徑呼叫 native `read`/`write`/`edit` 時，會解析到 **mikan daemon 進程自己的 cwd**（例如 repo 目錄），而不是該 Conversation office 的 workspace。`bash` 不受影響，因為 `pi-tools.ts` 另外把 `execution.cwd` 明確設為 `toolContext.env.cwd`。 | 改為 `new NodeExecutionEnv({ cwd: runtimeWorkspaceRoot })`。 |
| system prompt 對 host sandbox 描述的 bash cwd 錯誤 | `src/harness/prompt.ts` `buildEnvDescription`              | host 分支的 system prompt 文字寫「Bash commands start in: `${process.cwd()}`」，即使上一行已經正確顯示 `Runtime workspace root: ${workspaceRoot}`。model 依此文字可能誤判 bash 實際工作目錄（bash 真正的 cwd 早已固定為 `runtimeWorkspaceRoot`）。                                                                                                                                                                                    | 改為與其他 sandbox 類型一致，顯示 `${workspaceRoot}`。       |

兩者都在 host sandbox 部署下才會出現；container/cloudflare sandbox 走 `ShellExecutionEnv`，一開始就正確使用 `runtimeWorkspaceRoot`。這兩個問題不是 Pi 0.85.0 upstream 帶來的行為變化本身造成的，而是 mikan 自己的橋接程式碼（`27f29ca` 引入 native tools 時）從一開始就沒把 `runtimeWorkspaceRoot` 接進 host 分支；但正是本報告先前列出的「P1: host cwd smoke test」風險項目要抓的那類問題。

### 驗證

修正後的完整驗證：

```text
npm run lint && npm run fmt:check && npm run build && npm run knip && npm test
```

結果：lint / format / build / knip 全部通過；`npm test` **135 files / 1840 tests passed**。

## 再後續：0.86.0 breaking change 審查與端到端 bash cwd 回歸測試

深入比對 mikan 目前实際使用的 `0.85.1 → 0.86.0`（`packages/ai/CHANGELOG.md`）發現一個原報告未列出的 **breaking change**：`ProviderStreams`/`StreamFunction` 的 `context` 參數從 `Context` 改為 `TranscriptContext`，system prompt 與 tools 改為儲存在開頭 `SystemMessage` 而不是 `context.systemPrompt`/`context.tools`。[U15]

審查結論：**对 mikan 无影響**。mikan 未定義任何自訂 `Provider`/`ProviderStreams`（只用 `createProvider()` 包装內建 `CUSTOM_API_STREAMS` lazy adapters，不自己实作 stream 函數），也不直接呼叫 `.stream()`/`.streamSimple()`。mikan 對 system prompt/tools 的 mid-run 變更（`setSystemPrompt`、per-prompt `tools`）早已透過 `getCurrentSystemPrompt`/`getCurrentTools` 新 transcript API 測試（`src/test/harness-native.test.ts`），證明此転換對 mikan 既有行為透明。[M10]

另外比對了 `RetryPolicy.maxAgentDelayMs`（新 optional field，mikan 的 `DEFAULT_RETRY_SETTINGS` 未設定此值，依賴 pi-ai 預設 60 秒上限，不是 breaking）、`FileSystem.openTextLineReader`（新 required method，mikan 的 `ShellExecutionEnv` 已實作；`NodeExecutionEnv` 由 Pi 自己提供，兩者 host/container/cloudflare 全數覆蓋）與 container/cloudflare 的 `cwd`/shell 轉譯（皆在各自 executor 內把 `cwd` 正確映射到 guest 端命名空間，從一開始就不受 mikan process cwd 影響，與已修正的 host 分支問題不同）。[M7][M8]

### 新增：端到端 bash cwd 回歸測試

除了之前的 `ExecutionEnv.absolutePath`/`readTextFile`/`writeFile` 直接測試，新增 `src/test/sandbox-tools.test.ts` 一個透過真實 native `bash` tool（`createSandboxTools()` 產出的完整工具，不是低層 env）執行 `pwd` 的測試，驗證 model 實際呼叫 bash 時看到的工作目錄就是該對話的 workspace root。用同樣的 mutation-testing 方式（暫時恢原舌斷的 `process.cwd()`）確認此測試會在回歸時失敗，並回報 mikan repo 自己的目錄而非 workspace。

### 驗證

```text
npm run lint && npm run fmt:check && npm test -- src/test/sandbox-tools.test.ts src/test/execution-env.test.ts
```

結果：全部通過。

## 第一手來源

### 上游官方與發布套件

- **[U1]** [Pi v0.85.0 official release notes](https://github.com/earendil-works/pi/releases/tag/v0.85.0)
- **[U2]** [Release commit `107d79f`](https://github.com/earendil-works/pi/commit/107d79f11072bbc8a3a757ed7fd69596bee7d68c)
- **[U3]** [Official source comparison: v0.84.3...v0.85.0](https://github.com/earendil-works/pi/compare/v0.84.3...v0.85.0)
- **[U4]** [`packages/agent/CHANGELOG.md` at v0.85.0](https://github.com/earendil-works/pi/blob/v0.85.0/packages/agent/CHANGELOG.md)
- **[U5]** [`pi-agent-core` 0.85.0 `agent-harness.ts`](https://github.com/earendil-works/pi/blob/v0.85.0/packages/agent/src/harness/agent-harness.ts)
- **[U6]** [`pi-agent-core` 0.85.0 JSONL types](https://github.com/earendil-works/pi/blob/v0.85.0/packages/agent/src/harness/session/jsonl/types.ts)
- **[U7]** [`packages/ai/CHANGELOG.md` at v0.85.0](https://github.com/earendil-works/pi/blob/v0.85.0/packages/ai/CHANGELOG.md)
- **[U8]** [`pi-ai` 0.85.0 public message/types](https://github.com/earendil-works/pi/blob/v0.85.0/packages/ai/src/types.ts) and [assistant message frames](https://github.com/earendil-works/pi/blob/v0.85.0/packages/ai/src/utils/assistant-message-frame.ts)
- **[U9]** [new Cloudflare AI binding source](https://github.com/earendil-works/pi/blob/v0.85.0/packages/ai/src/api/cloudflare-ai-binding.ts) and [removed old binding in compare](https://github.com/earendil-works/pi/compare/v0.84.3...v0.85.0#diff-99dd777046502557b42d74a1fca32e3edb4be70da56c8fd08f1848bb47687488)
- **[U10]** [`pi-ai` 0.85.0 package exports](https://github.com/earendil-works/pi/blob/v0.85.0/packages/ai/package.json) and [model types](https://github.com/earendil-works/pi/blob/v0.85.0/packages/ai/src/types.ts)
- **[U11]** [cwd fix PR #8627](https://github.com/earendil-works/pi/pull/8627) and [0.85 tool sources](https://github.com/earendil-works/pi/tree/v0.85.0/packages/agent/src/harness/tools)
- **[U12]** [write count issue #8979](https://github.com/earendil-works/pi/issues/8979) and [`write.ts`](https://github.com/earendil-works/pi/blob/v0.85.0/packages/agent/src/harness/tools/write.ts)
- **[U13]** [`NO_PROXY` fix PR #8737](https://github.com/earendil-works/pi/pull/8737), [plain HTTP proxy issue #8134](https://github.com/earendil-works/pi/issues/8134), and [`node-http-proxy.ts`](https://github.com/earendil-works/pi/blob/v0.85.0/packages/ai/src/utils/node-http-proxy.ts)
- **[U14]** [`packages/coding-agent/CHANGELOG.md` at v0.85.0](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/CHANGELOG.md)
- **[N1]** [`@earendil-works/pi-agent-core@0.85.0` registry metadata](https://registry.npmjs.org/@earendil-works%2fpi-agent-core/0.85.0) / [tarball](https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.85.0.tgz)
- **[N2]** [`@earendil-works/pi-ai@0.85.0` registry metadata](https://registry.npmjs.org/@earendil-works%2fpi-ai/0.85.0) / [tarball](https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.85.0.tgz)
- **[N3]** [`@earendil-works/pi-coding-agent@0.85.0` registry metadata](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent/0.85.0) / [tarball](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.85.0.tgz)
- **[U15]** [`packages/ai/CHANGELOG.md` at v0.86.0](https://github.com/earendil-works/pi/blob/v0.86.0/packages/ai/CHANGELOG.md) and [`packages/ai/src/types.ts` diff v0.85.1→v0.86.0](https://github.com/earendil-works/pi/compare/v0.85.1...v0.86.0#diff-fe318fe4)

### mikan repo 證據

- **[M1]** [`src/sessions/session-store.ts`](../../src/sessions/session-store.ts) — Pi imports、current header validation、舊格式 early error
- **[M2]** [`src/sessions/migrate-pi-084.ts`](../../src/sessions/migrate-pi-084.ts) 與 [`src/sessions/README.md`](../../src/sessions/README.md) — offline migration contract
- **[M3]** [`src/harness/session.ts`](../../src/harness/session.ts) — auth、native lane admission/drive/resume/cancel、events/hooks、tool result forwarding
- **[M4]** mikan commits [`aca419e`](https://github.com/geminixiang/mikan/commit/aca419e611713f135feeca21282699beb18dbd13), [`192c47c`](https://github.com/geminixiang/mikan/commit/192c47c4376e7d428e27e72e0b1ccda9ff4ac244), [`b811b49`](https://github.com/geminixiang/mikan/commit/b811b491d91d5b9aa53501b7fbf84759a9d25186), [`9c6e38d`](https://github.com/geminixiang/mikan/commit/9c6e38da0ea6e3800e6f61739b1ca2db636dc6d0)
- **[M5]** [`package.json`](../../package.json), [`package-lock.json`](../../package-lock.json), and repo-wide Pi imports — direct dependencies/current lock and absence of `pi-coding-agent`
- **[M6]** [`src/harness/models.ts`](../../src/harness/models.ts) — built-in catalog、lazy adapters、custom `compat`
- **[M7]** [`src/harness/tools/pi-tools.ts`](../../src/harness/tools/pi-tools.ts) — sandbox-backed Pi tools and pinned bash cwd
- **[M8]** [`src/harness/execution-env.ts`](../../src/harness/execution-env.ts) — host/container/cloudflare cwd/path resolution
- **[M9]** [`src/harness/http.ts`](../../src/harness/http.ts) and [`src/main.ts`](../../src/main.ts) — global undici dispatcher/proxy setup
- **[M10]** [`src/harness/session.ts`](../../src/harness/session.ts) `setSystemPrompt`/per-prompt `tools`, and [`src/harness/models.ts`](../../src/harness/models.ts) `createProvider`/`CUSTOM_API_STREAMS` — mikan's only touch points on `Provider`/`ProviderStreams` and mid-run prompt/tool changes
