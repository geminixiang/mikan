# pi-agent-core 1.0.0：mikan 最小遷移與責任邊界

> 後續決策：mikan 採 pi-durable，見 [ADR 0017](../adr/0017-pi-durable-harness.md)。下文是決策前的研究紀錄。

> 研究日期：2026-10-02。最新使用者要求先暫停實作，研究 pi-agent-core 是否消失。本研究不選定新 runtime，不引入 pi-coding-agent、不使用 private imports、不複製 Pi execution internals。讀取已安裝 core/ai/codemode/mcp 1.0.0、現有 checkout、官方 GitHub 變更與公開 npm artifacts；本研究未安裝依賴、改 production code、執行平台測試、commit、push、發布或部署。開始研究前已有版本試裝及程式異動，仍未完成相容性修正。

## 套件究竟發生什麼事

**pi-agent-core 沒有消失，也不是改名成 coding-agent。** npm `@earendil-works/pi-agent-core` 的 `latest` 是 1.0.0，發佈時間為 2026-10-01T19:10:36.594Z。官方於當日 commit `7fd478a2e888` 明確移除 experimental harness；1.0.0 changelog 指定 durable sessions 改用 `@earendil-works/pi-durable`。[P1][P2]

| 套件              | 1.0.0 的定位                                                 | 對 mikan 的意義                                               |
| ----------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `pi-agent-core`   | `Agent`、agent loop、proxy 與相關型別                        | 仍存在；不再包含 mikan 使用的 durable/session API             |
| `pi-durable`      | 新 durable harness、storage、tasks、compaction、coding tools | 官方指向的替代；不是舊 API 原名搬家，README 仍標 experimental |
| `pi-coding-agent` | CLI 與 coding-agent SDK                                      | 另一條整合路線；本研究不要求新增這個依賴                      |
| `pi-codemode`     | 獨立 QuickJS sandbox 與 declarations                         | 仍存在；升級 engine 不會替 mikan 修復 durable/session imports |

移除 commit 同時刪除舊 `packages/session-backends` 與 experimental mini/micro frontends。先前只查 core exports 就推論「必須改用 coding-agent 或自己接手 sessions」不完整；官方有 pi-durable，應先評估它，避免自建第二套持久化／execution framework。[P1][P2]

## 遷移影響

**可行，但不是改 import 就完成的升級。** core 1.0.0 的公開 `Agent` 負責 in-memory transcript、模型迴圈、工具 validation/hooks/dispatch、stream events 與 cancellation；不提供舊 `AgentHarness`、`AgentLane`、`JsonlSessionRepo`、`ExecutionEnv`、coding tools 或 compaction engine。[C1][C2]

有一個不能忽略的第一方替代：**`@earendil-works/pi-durable@1.0.0` 確實公開提供新的 durable Harness、JSONL/SQLite storage、ExecutionEnv、coding tools、compaction、recovery。** 它是 experimental、不同資料模型，而且直接依賴 pi-ai/Chord，**不是 core `Agent` 外掛或舊 API 的原名搬家**。因此「沒有任何官方替代」和「只換到 pi-durable 就原樣相容」都不正確。[D1][D2][D3]

若必須由 core `Agent` 驅動，最小可運行版本應採 **Agent + mikan 小型 session journal/policy + 公開 `runToolCall()` + 現有 sandbox Executor**。代價是 mikan 接手持久化、compaction 與 crash recovery 政策；如果還要求原有 durable lane、transaction/memo 與自動恢復完整保證，這就不是小 wrapper 的範圍，必須另外批准採 pi-durable 或暫緩切換。[M1][M2]

## 查證範圍與結果

- 已安裝 core 的 `package.json` 僅 export `.` 與 `./package.json`，根入口為 agent/agent-loop/proxy/types/stream-fn；不再有合法 `/node` export。列出 installed dist 與公開 declarations，沒有舊 session/harness/env/tools 模組。ai/codemode/mcp 根入口也未提供這些舊 API。[C1][A1]
- `npm run typecheck` **失敗**，實際重現 `AgentHarness`、`AgentLane`、`JsonlSessionRepo`、`ExecutionEnv`、`createReadTool` 等移除，以及 custom message roles/types 的連帶錯誤；不是只缺三個 export。[M3]
- 讀取官方 npm registry search 與 `npm view`：找到 pi-durable 1.0.0；舊 `pi-session-backend-sqlite-node` 最新結果為 0.99.2，依賴 core/ai ^0.99.2，不是已查證的 1.0 替代。
- pi-durable tarball 只下載至 `<TEMP_RESEARCH>/package` 供 README、exports/declarations/storage source 檢查，**沒有安裝、import 執行或 install scripts**。registry 搜尋不是所有未來套件的不存在證明。[D1]

## before/after 與責任歸屬

| 契約                     | 現有 mikan / 舊 native harness                                     | core 1.0 公開能力                                                                                                 | 必要 owner / 最小遷移                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 模型迴圈                 | lane admission/drive、operationId                                  | `Agent.prompt/continue`、`finishTurn`、`prepareRequest`、`prepareNextTurnWithContext`                             | Pi 擁有迴圈；mikan 不複製它。用 callback 注入 policy/context [C2]                                                                                                        |
| Direct tools             | 六參數 harness-native execute，toolContext/invocation/Context      | `AgentTool.execute(id,args,signal,onUpdate)`，before/after hooks                                                  | mikan 將授權 Executor、office/run context 以每 run/tool closure 注入，不使用 ambient process globals [C2][M4]                                                            |
| Codemode nested dispatch | `executeNestedTool` 自行 validation/loop guard/progress/memo       | **公開 `runToolCall()`**：同 direct validation/prepare/hooks/execute/finalize；不 append messages、不 emit events | 刪除舊橋接的重複 dispatch，使用公開函式；只留 grants snapshot、nested ID、progress/accounting 與 result mapping [C3]                                                     |
| Failure                  | 0.99.1 native harness 正常 return 的 isError 與舊 AgentTool 有落差 | `AgentToolResult.isError:true` 原生保留 content/details/structuredContent；`runToolCall` outcome 帶 flag          | 使用原生 flag，不再套前輪 after_tool marker workaround；保留 codemode native error kind/stack/output/calls [C2][C3][M5]                                                  |
| Tool discovery           | native lane active-tools / branch custom state                     | `agent.state.tools` 可更新；模型工具宣告差異於下一 request 以 system message 公告                                 | mikan 持久化 loaded names，重開交集目前 grants；不可把 discovery 當 permission grant [C2][M4]                                                                            |
| Prompt / history         | 原生 session projector/summary messages                            | system messages 承載 prompt/tools；state.systemPrompt read-only；`convertToLlm/transformContext`                  | mikan 持久化 system patches/custom metadata；projector 必須確保 summary、history、tools 宣告一致 [C2][A1]                                                                |
| Session durability       | v4 JSONL Session/Repo、atomic mutations、writer lease              | **沒有 repository 或檔案 codec**；sessionId 只是 provider/cache identifier                                        | mikan journal/單 writer/private atomic snapshot；Agent memory 不等於 durable session [C1][M1]                                                                            |
| Compaction               | lane.compact、idle compaction、threshold/overflow policy           | `transformContext`/request hooks 是 seam，沒有 summarizer/structural commit API                                   | mikan summary policy + durable summary/cut；只 prune request 不等於持久 compaction。或另採 pi-durable [C2][D2]                                                           |
| Crash recovery           | native intent/outcome、operation/memos、resume lane                | `continue()` 只續 transcript；`AgentTool.replay` 欄位存在但 Agent loop 沒有 storage/recovery scheduler            | mikan 決定 interrupted policy；不可聲稱 replay:safe 自动帶來 crash recovery [C2][C3][D2]                                                                                 |
| Retry                    | native retry events/drive                                          | ai 公開 `isRetryableAssistantError/retryAssistantCall/retryDelayMs`；Agent error/abort hard exit                  | mikan 使用公開 helpers、bounded provider retry；不得用 generic retry 重跑已執行工具 [A2]                                                                                 |
| Sandbox / tools          | core ExecutionEnv、NodeExecutionEnv、read/write/edit/bash          | core 無此 export                                                                                                  | core-only 路線用 mikan Executor，實作最小 coding tool 行為；不得複製 Pi tool internals。若要官方 coding tools，可另評估 durable/tools，但不是 AgentTool drop-in [D3][M4] |
| Progress / budgets       | native run/entry/usage/retry/compaction events                     | agent/message/turn/tool_execution events；subscribe listeners 會 await                                            | mikan event adapter、run IDs、usage/budget 計數；持久化 listener 納入 settlement，close 前 abort + waitForIdle [C2]                                                      |

### Native dispatch 的具體可刪除部分

`runToolCall(toolCall,{tools,assistantMessage,context,signal,onUpdate,beforeToolCall,afterToolCall})` 是 root export，不需 private import。它接受已授權的 executable loadout，回 `{toolCall,result,isError}`。unknown/invalid/blocked/throw 都是 error outcome。用目前 requesting assistant/context snapshot；不要替 nested calls 捏造假的 transcript 或讓它發現未授權工具。[C3]

此 API **不會**發 progress events 或寫 model transcript，因此必要 wrapper 只做 nested call ID、呈現/計數、result-to-script mapping；Pi 已負責 argument preparation/validation/hooks/errors。codemode scripts 只輸出聚合值，nested 原始 results 不入 model history。[C3][M5]

## v4 session：不能當 AgentMessage[] 直接讀取

現有契約為 header `{kind:"header",v:4,storageVersion:1}`；後續有 entry、value/list writes（也可能 batched array）、branch parent links、metadata、compaction retainedTail、branch_summary 及 native operation state。`SessionStore.buildContext()` 是 **inspection reader**，舊 README 明確不讓它接管 LLM execution；失敗/aborted/deferred assistant 也有排除規則。[M1][M2]

最小安全導入方案（尚未實作）：

1. 原始 `<OFFICE>/sessions/<SESSION>.jsonl` 唯讀保留，不原地假裝 core1 相容；寫新版本 mikan-owned journal/snapshot，記錄 source lineage、session ID、同步 cursor 與 loaded-tool names。
2. 只導入 **已確定 settled** 的 main branch 可見 context；驗證 header、envelope、seq、branch tip 與 transaction commitment，再套最後有效 compaction summary/retained tail。不能僅掃描所有 `type:message` 或把 malformed/部分 commit 當成功。
3. 舊 summary/custom roles 在 core1 `AgentMessage` 預設 union 中不存在：用 mikan-owned custom type + `convertToLlm`，或明示映射到合適標準 message。保留工具 call/result 配對與 system/tool patches，避免摘要與工具狀態不一致。[C2][M2]
4. 未完成 operation/unknown tool outcome 一律隔離、標 interrupted，**不重播副作用**。若沒有經驗證的舊 v4 committed-state reader，MVP 先只開新 session，舊檔 inspection-only；不能宣稱舊 session 全面無損 resume。
5. 用 fixture 測 branch、compaction、多筆 batch writes、partial trailing write、pending side effects、revoked grants、parent lineage、concurrent writer 與 close/cancel，再決定 rollout。現有 test imports 已壞，必須建立新 baseline，不能以本輪 typecheck 失敗冒充遷移已驗證。

這是產品資料的 format-specific importer，不是抄 Pi execution internals。若解析 v4 commitment/operation 格式仍需要舊 Pi 私有程式，不應拼出一套 speculative compatibility engine；保持原檔並列為遷移 blocker。

## 官方 pi-durable：提供替代，但須另做選擇

| 第一方 package 證據                                                                                                      | 可保留的需求                                                            | 不相容／需決策                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| root exports `Harness/createSession/CompactionTask/ToolTask/MemoryStorage`；合法 storage/jsonl/node、storage/sqlite/node | durable admissions/tasks、metadata documents、compaction/retry/recovery | 依賴 pi-ai + Chord，不依賴 core Agent；選它作 runtime 是另一條路，不是本題 core Agent 遷移 [D1][D2]                                        |
| env / env/node exports ExecutionEnv、NodeExecutionEnv 等                                                                 | 現有 sandbox capability adapter 的概念相近                              | 新 FileSystem 增加 namespace `id`，Context 為 Chord；不能只改 import 無測試 [D3]                                                           |
| tools exports createRead/Write/Edit/BashTool、CodingTools                                                                | 官方 coding tools，不需 copy implementation                             | `ToolRegistration.execute(args,api,context)` 不是 core AgentTool；依賴 invocation-bound api/env/output/doc/task，不能假裝現成 drop-in [D3] |
| durable tool intent 先 commit；replay safe/unsafe；unsafe interruption 回 error                                          | 原有 crash recovery 保證                                                | core 的 replay 值為 never/safe，durable 為 unsafe/safe；不能照搬 policy 名稱 [C2][D2]                                                      |
| JSONL directory main.jsonl + doc/task sidecars，commit marker `{format:1,type:"commit",seq,writes}`、numeric IDs         | 具 first-party atomic commit/recovery storage                           | **不是舊單檔 v4**；沒有在已查 README/exports/storage 找到 v4 importer。需明確 mapping、驗證及備份 [D4]                                     |

**建議下一步**：依 mikan 目前要求由 Pi 擁有 durable session、compaction 與 recovery 的契約，先做 **pi-durable 的隔離相容性試作與 ADR**，不直接上 Prod、不默默改用 core-only MVP。只有明確接受 mikan 自行承接這些責任、並降低未完成 operation 恢復保證時，才選 core `Agent` 路線。不得在 core Agent 外再複製 durable generation/task scheduler，以形式上滿足 core dependency 卻引入兩套 executor。兩條路均不是本輪已完成的實作。

## 最小實作順序與阻塞

1. **決策 gate**：確認 MVP 能否暫不支援 in-flight v4 resume / durable effect recovery，以及是否允許 mikan owning compaction/session codec。這是從「Pi 擁有」到「mikan 擁有」的 consequential compatibility change，需記錄架構決策。
2. 工具與 runtime：AgentTool 四參數、run-bound Executor closures、public runToolCall、failure flag、events/cancel/budget；core typecheck 通過。
3. session store：小型獨立 journal + committed snapshot、單 writer、office isolation/private permissions；prepareRequest 裝入 canonical context；await subscribe persistence。
4. compaction/retry：使用 public request/turn hooks 與 ai helpers，另定 summary/cut persistence；callback 不丟例外破壞 loop contract。選擇截 context 必須明示，不得靜默關 compaction 無限長跑。
5. v4 importer 與 crash tests：保留源檔、驗證 settled transcript、unknown outcomes fail closed。舊 parent/session metadata 與 tool discovery 復原不能丟。

**尚未解決**：v4完整 commitment/recovery codec、session格式產品決策、coding tools 的官方 reuse 與 core-only 限制取捨、durable restart保證、compaction策略／成本與新 typecheck/test baseline。沒有 production-ready 的遷移程式或 release。

## 驗證紀錄

- installed public declarations/source、mikan README/code/tests 交叉閱讀；registry metadata 與 pi-durable 1.0.0 官方 tarball 靜態查驗。
- `npm run typecheck`：失敗，主要是 removed APIs 及連帶 typing，不做修正。
- 純本機、無模型/網路的 `runToolCall` fixture：returned `isError:true` 保留 partial content/details；before/after hooks 各一次；原 context messages 未增加；缺必填參數得到原生 validation error outcome。這驗證 dispatch seam，不代表 session/recovery 已遷移。
- 本研究檔以現有 oxfmt 格式化；`npm test -- src/test/doc-references.test.ts` 通過（3 tests），不是外部連結可用性檢查。
- 只新增本研究檔；既有他人 package/code 改動未改、未還原。無 dependency installation、平台測試或發布動作。

## 引用（第一方／本機實查定位）

官方 main links 供 source 定位；版本結論以 installed **1.0.0** declarations 或 npm **1.0.0 tarball** 為準，main 可能漂移。

- **[P1]** [移除 commit](https://github.com/earendil-works/pi/commit/7fd478a2e888)：`feat(agent): remove the experimental harness from pi-agent-core`；commit body 指明 durable sessions 位於 pi-durable，並移除 session-backends／mini／micro。
- **[P2]** [core 1.0.0 changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/agent/CHANGELOG.md)、[durable 1.0.0 README](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)、[durable 1.0.0 changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/CHANGELOG.md)；npm `view` 的 dist-tags/time 與各版本 gitHead 交叉查證。core 的 0.99.1、1.0.0 artifact gitHead 分別為 `d86654abb8862e201933517d6f1fce9f88dd117f`、`a13d35a742c6ef8462812a28fbe1d8c8b7431c32`。
- **[C1]** installed `pi-agent-core/package.json` exports、`dist/index.d.ts`、dist 模組列表。[package](https://www.npmjs.com/package/@earendil-works/pi-agent-core/v/1.0.0)、[root source](https://github.com/earendil-works/pi/blob/main/packages/agent/src/index.ts)。
- **[C2]** installed core `README.md`（Request preparation、Transcript、With MCP and codemode）、`dist/agent.d.ts`、`dist/types.d.ts`（AgentOptions/AgentState/AgentTool/AgentToolResult/AgentEvent）。[README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)、[Agent](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent.ts)、[types](https://github.com/earendil-works/pi/blob/main/packages/agent/src/types.ts)。
- **[C3]** installed core `dist/agent-loop.d.ts` RunToolCallOptions/runToolCall；`dist/agent-loop.js` runToolCall/executePreparedToolCall/finalizeExecutedToolCall。[public loop source](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)。
- **[A1]** installed ai/codemode/mcp `package.json` exports/root declarations；ai `dist/session-resources.d.ts` 只是 resource-cleanup registry，非 Session repository；ai transcript helpers。[ai root](https://github.com/earendil-works/pi/blob/main/packages/ai/src/index.ts)。
- **[A2]** installed ai `dist/utils/retry.d.ts`、`dist/utils/overflow.d.ts`；公開 helpers 不等於 core 提供 durable retry scheduler。[retry](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/retry.ts)、[overflow](https://github.com/earendil-works/pi/blob/main/packages/ai/src/utils/overflow.ts)。
- **[D1]** 官方 registry `npm view @earendil-works/pi-durable@1.0.0`（version/dependencies/exports）；[1.0.0 artifact](https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.0.0.tgz)、[package](https://www.npmjs.com/package/@earendil-works/pi-durable/v/1.0.0)。未安裝。
- **[D2]** D1 tarball `README.md`（Experimental、Persist and Resume、Tools、Compaction）、`dist/index.d.ts`、`dist/harness/generation.js` imports：直接 pi-ai/Chord 與 durable tasks，不是 core Agent wrapper。
- **[D3]** D1 tarball `dist/env/index.d.ts`、`dist/env/node.d.ts`、`dist/tools/index.d.ts`、`dist/harness/types.d.ts` ToolRegistration/ToolExecutionApi。
- **[D4]** D1 tarball `dist/storage/jsonl/node.d.ts`、`storage.d.ts`、`storage.js` FORMAT_VERSION/parseMainMarker、`dist/entries.d.ts`：新 commit directory 與 entry/head 模型。
- **[M1]** 本 checkout [sessions README](../../src/sessions/README.md)、[session-store.ts](../../src/sessions/session-store.ts)：header/openFileSession/buildContext、writer lease、createHarness；[session types](../../src/sessions/types.ts)。
- **[M2]** [session-file-store tests](../../src/test/session-file-store.test.ts)：v4 envelope、batched metadata、compaction/branch projection；[migration file writer](../../src/migrations/session-files.ts)。
- **[M3]** 本輪 typecheck 輸出，暫存位置公開表示為 `<LOCAL_VERIFICATION>/core1-typecheck.log`；[package.json](../../package.json) 四項 Pi 依賴 ^1.0.0。
- **[M4]** [harness README](../../src/harness/README.md)、[session.ts](../../src/harness/session.ts)、[pi-tools.ts](../../src/harness/tools/pi-tools.ts)、[execution-env.ts](../../src/harness/execution-env.ts)、[sandbox types](../../src/sandbox/types.ts)：舊 harness/env、native tools、現有 Executor。
- **[M5]** [codemode.ts](../../src/harness/tools/codemode.ts)、[前輪研究](pi-codemode-fluency-contracts-2026-10.md)：0.99.1 native harness failure workaround 僅為舊版本問題，不能推定 core1 仍需同樣 patch。
