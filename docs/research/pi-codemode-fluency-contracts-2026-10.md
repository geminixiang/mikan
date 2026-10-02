# Pi codemode 流暢度：原生契約與 mikan 最小對齊研究

> 研究日期：2026-10-02（本機時間）。僅研究、讀取既有證據及新增本文件；未改 production code／設定，未安裝依賴、重跑平台測試、commit、push、release 或部署。Pi coding-agent installed snapshot **0.99.2**；mikan 的 pi-codemode／pi-agent-core **0.99.1**；mikan checkout **0ccca1c1a711b8ab94b54e12f8bf3baab772a55b**。官方連結的 `main` 是原始碼定位，不保證與已安裝版本永遠一致。

## 結論

Pi 的流暢不是另一套 executor 或必需的 codemode skill，而是一條一致的鏈：**模型先得到真實 API 宣告 → 按需探索完整 sample → 依回傳型別寫腳本 → 只輸出聚合值 → 原生失敗保留定位及已執行呼叫資訊**。mikan 已使用官方 QuickJS engine，且 `0ccca1c1` 已補 async globals／官方 samples／探索範例；不要重複把已修正項目當缺失。[P1][P2][P3][M1]

最新隔離 Slack 證據顯示 helper 名稱與 `await` 已正確，但模型仍把探索與未知工具呼叫塞進同一段程式、猜參數及把 JSON 文字當物件，兩次自修才完成。**優先處理失敗結果的原生傳遞、保留 native diagnostics，並驗證 discover-first 的兩段流程；不是先換搜尋器或擴充 executor。** 這是有來源的優化排序，不是相同模型 Pi/mikan A/B 成功率結論。[E1]

## 最新隔離 Slack 證據（既有 artifacts，非本輪 live 測試）

證據集 [E1] 完成於 **2026-10-01T17:43:40Z**，對 checkout `0ccca1c1` 編譯檔，codemode SHA-256 為 `5b8806b162075117e9abd2e952b02371937c1edc31957c01821c81029917bd84`；metadata 記錄 fresh state、ego-browser access、沒有額外 helper 教學，三項 task 都有 local intake。測試模型為公開 `openrouter/openai/gpt-5.4-mini`。本研究交叉讀取 verification、persisted session、MCP calls log；不讀 credentials、不重新連接 Slack。[E1]

| 任務                   | 實際結果                                                                                                                                                                     | 可以／不可以推論                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| T1：兩個 bash 呼叫     | codemode `Promise.allSettled`，結果 `42`                                                                                                                                     | 編排／聚合可用；不代表所有 tool errors 都正確標記                                                             |
| T2：deferred discovery | `tool_search` 載入 `mcp__qa__list_batches`，下一回合 direct call 成功                                                                                                        | native active-tool declaration 路徑可用                                                                       |
| T3：兩批唯讀 MCP 聚合  | 先重用 T2 工具；helper 名稱與 await 正確；猜 `batch` 而非必填 `id`；第二段已輸出 `Promise<string>` 宣告但仍當物件；第三段 `JSON.parse` 後得到 `total=56, kept=4, keptSum=48` | **不是 first-attempt pass**；修正原先 global/await 問題不等於所有契約理解已解決                               |
| 隱藏資料／並行         | 原始 unused payload 未入模型歷史；fixture log 有兩個 alpha/beta barrier cycles                                                                                               | 支持過濾及 fixture 並行；不是正式 MCP service 的成功率／效能測量                                              |
| 失敗 delivery          | 兩個內容明確失敗的 codemode persisted toolResults 都是 `isError:false`                                                                                                       | 與 wrapper 意圖不同；installed native harness 正常 return 一律 outcome.isError:false，已交叉支持傳遞缺口 [P6] |

與 [舊研究](pi-codemode-discovery-guidance-2026-10.md) 的 SDK smoke 分開：該 smoke 第一次就以探索 script／後續呼叫 script 算出 `56/4/48`；最新 Slack T3 則經兩次自修。兩者不是同一輪測試，不能以 smoke 覆蓋 Slack 首次失敗。[E1][M5]

## 真正的第一方契約對照

| 面向                | Installed Pi coding-agent 0.99.2／engine 0.99.1                                                                                                            | mikan `0ccca1c1`                                                                                                                                                                            | 最小建議                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guidance            | tool description 分 output／async globals／deferred discovery；system prompt 有批次 guidelines；direct tool description 附 codemode declaration            | 已有 globals 共用定義、`renderDeclarations({globals})`、await 範例、allSettled、先輸出未知宣告再寫 later script；沒有 coding-agent prompt guideline layer                                   | 保留已對齊內容；再以無額外教學的 fixture 比較 discovery-first 遵守率，不新增大 skill [P1][M1][M4]                                                                         |
| Catalog budget      | 按 namespace 與完整工具 section 選取                                                                                                                       | nested catalog `.slice(0,12000)` 可能截斷 schema；globals 不受此限制                                                                                                                        | 小型完整區段 budget；不要任意截半個宣告 [P1][M1]                                                                                                                          |
| Discovery           | BM25/default 8；namespace aliases；describeTool 支援 raw／normalized name；describeNamespace 取 server instructions；ALL_TOOLS descriptions 為完整 samples | weighted keyword/default 5／exact namespace；samples map raw name；ALL_TOOLS 為原始 description；無 describeNamespace                                                                       | 先用公開 `toCodemodeIdentifier` 接受 aliases。mikan 已注入 MCP instructions，不是完全無 server guidance；BM25 改善尚未證實 [P2][M1][M2][M3]                               |
| Nested result       | 有 outputSchema 且有 structuredContent 時先回 structuredContent，包括帶 MCP isError 的 structured result；其他 outcome failure reject                      | 通用 bridge 先 isError throw，再回 structuredContent；純 text 為 string，含 image 為 `{content}`                                                                                            | 宣告與實際值對齊；不要承諾完整 MCP wrapper [P2][M1]                                                                                                                       |
| MCP adapter         | 官方 MCP docs／declarations 描述 CallToolResult 型別；script 可檢查其 isError（適用具 structured schema 回傳路徑）                                         | connectServer **未保留 MCP outputSchema**；guard 成功僅 content/details，structured fallback 轉 text，超限 bounded/spill，isError throw；所以純文字 MCP 的 `Promise<string>` 是當前真實契約 | 若維持 bounded text，保持宣告並明示 JSON.parse 及可能截斷；若保留 structured envelope，需明示 compatibility／bounded-result security 變更，不是只換 renderer [P2][P4][M3] |
| Return/output       | CLI `valueText`：string 原樣，其他 JSON；僅 output/value 入模型，calls 存 details                                                                          | 成功 return 一律 JSON.stringify；只 output/value 入模型，details undefined                                                                                                                  | string 引號是 CLI 差異，**非違反所有官方實作**：engine README adapter 也 stringify。先選契約再測 [P2][P3][M1]                                                             |
| Failure diagnostics | native engine 提供 kind/name/message/stack、失敗前 output、calls；CLI 顯示失敗 header、stack 或分類文字與 calls，提醒 side effects 不撤回                  | 僅 error.message；calls/stack/kind 未傳出；前段 output 可耗完 shared budget，最後 error 也可能被截掉                                                                                        | 直接 format 公開 native result，預留診斷空間及 bounded call summary；不要造第二套 error classifier/retry [P2][P3][M1]                                                     |
| Output overflow     | CLI 合併文字 head/tail，full output 寫檔，可用 read offset/limit；details 有 fullOutputPath                                                                | 每段前綴截斷，無 codemode full-output spill；image 不算文字 budget；最多 40000 字元近似 token budget                                                                                        | 第一優先是模型在 VM 聚合／少輸出。spill 若必要，必須 office-scoped/private/redacted；不可直接抄 CLI host temp path [P2][M1][M3]                                           |

### Native error 的精確界線

**已核實 native harness 與舊 Agent adapter 的 failure protocol 不同。** pi-agent-core 0.99.1 `harness/execution/tools.js` 的 `executeToolCall()` 正常 return 為 `{result,isError:false}`，throw 才為 true；`createToolResultMessage()` 用 outcome flag，不讀 nested `result.isError`。因此 mikan codemode 的 `{isError:!result.ok}` 沒有標記 native failed outcome，與最新 Slack persisted flags 一致。不能直接照搬 engine README／CLI AgentTool 的回傳方式。[P6][M1][E1]

可用現有 **公開 `after_tool` patch `{isError:true}`**，保留 content/details/usage，而非 throw 丟失 partial output。最小候選是 codemode details 放一個型別可驗證、專屬且不含私密資料的 native failure marker；session hook 僅對 codemode＋該 marker 設 flag，並與 loop notice patch 合併。也可採 per-call state，但需 toolCallId 精確匹配及清理，不能跨 session 漂移。這是待 fixtures 驗證的適配設計，**本輪未修正**；不要用錯誤文字 regex 猜 flag。mikan 既有 after_tool 只加 loop notice，尚未做此轉換。[P6][M2]

engine 公開 `CodemodeError.kind` 為 `script | timeout | aborted | sandbox`；`name/stack` 是 **script error** 資訊，不是任何 host tool throw 都完整跨 VM。`CodemodeTool.execute` throw 原生只承諾 script 端 `Error` 的相同 message。模型自行 throw `TypeError` 的本機 fixture，研究員觀察 `ok:false`、script TypeError stack（含 `codemode.js` 位置）、partial output 及已完成 call。不得宣稱 host stack 也原樣保存。[P3]

mikan 已用 native engine，沒有理由從 message 另猜 error 種類。engine README 最小 adapter 已使用 `result.error.stack ?? result.error.message`，目前 mikan 甚至丟掉這層現成資訊。calls 只摘要名稱／status 即可；不應重新把全部 args、nested results 或私密內容塞入歷史。[P3][M1]

## 公開 API 與必要 wrapper 的邊界

| 選擇                                                                                                           | 替代方案                                              | 理由                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保留公開 CodemodeSandbox、parseCodemodeSource、renderDeclarations、renderToolSample、toCodemodeIdentifier      | 重建 executor／schema renderer                        | 已安裝 engine 的 root／合法 exports 即有；schema renderer 只宣告，不做驗證，保留公開 validateToolArguments [P3][M1]                                                                                             |
| 保留 mikan executeNestedTool 小橋接                                                                            | 直接抄 engine README 舊 AgentTool/runToolCall adapter | mikan 用 AgentHarness；README 記錄目前沒有 public native nested dispatch；橋接維持 grants/context、loop guard、cancel、progress/accounting、invocation memo，不是任意 native hooks 或 durable nested steps [M2] |
| 借用官方說明結構及 output/error 契約，自己少量適配                                                             | deep import createCodemodeDescription／Bm25Ranker     | 兩者非 coding-agent root exports；避免把 CLI 私有 implementation 搬入 harness [P1][P2][P5]                                                                                                                      |
| 若將來整體採 coding-agent SDK，使用 createCodemodeExtension／createToolSearchExtension + DefaultResourceLoader | 把 extension 當 native harness drop-in                | 官方 SDK 另需啟用工具、bindExtensions；屬 session/resource-loader 架構，不是取一個 formatter 的低成本替換 [P5]                                                                                                  |

不把 durable store/load、models/classifier、換 BM25、放寬 deadline／heap 列為已證實必要優化。mikan 60s／64MiB；CLI snapshot 預設 Infinity／256MiB；engine library default 300s／未另設 heap limit，三者不同。mikan script-local store 是誠實限制，不能無實作地抄跨回合承諾。[P2][P3][M1]

## 建議後續工作（本輪未實作）

1. **P0：native failure boundary**：以公開 after_tool patch 適配已核實的 returned result／native outcome 差異；先固定 script throw、argument validation、host tool failure、timeout、abort 各自對 model-facing isError／persisted outcome 的期待，保留 partial output／details。修正「failure 文字卻 native success」再改善格式。[P6]
2. **P1：native diagnostics**：保留 kind/name/stack、partial output 與 calls 摘要，預留 error budget；test「先有成功 side effect 再 throw」及「巨大 text 後 throw」，不要 automatic retry 已完成副作用。
3. **P1：discovery-first／return contract**：保留未知工具兩段式探索，分別 test JSON text、structured result、image、MCP bounded/truncated/error。宣告的 Promise 型別必須與 bridge 真正回傳值一致。改 MCP structured envelope 應獨立設計、明示 compatibility，不能默默改語義。
4. **P2：完整 catalog budget／identifier aliases**：直接使用公共 renderer 與 identifier API；測試非 identifier 名稱、空 matches、超 budget 不產生半截 TS schema。
5. **驗證**：先本機 fixtures，待另行批准才做新 fresh-state Slack；原任務、不加 helper 補教，記錄 first-attempt success、自修回合、native error flag、正確答案、unused payload absent、真正並行 evidence。相同模型與任務 Pi/mikan A/B 才能比較「流暢」改善幅度。

## 本輪驗證

- installed first-party docs/source 與 mikan source 交叉檢查；兩位研究員獨立核對 MCP 結果契約。
- 既有 Slack verification 與 persisted session 的 failure flags、fixture barrier log 交叉核對；沒有重新跑 Slack。
- 選定 Markdown 已用現有 oxfmt 格式化；`npm test -- src/test/doc-references.test.ts` 通過（3 tests）。該 guard 檢查 guides／module READMEs，不是外部網址 availability checker。
- checkout 只有本研究檔新增；beta npm 安裝／發布、push、Prod VM 部署均未執行。

## 來源與可重查定位

以下 Pi 第一方檔案均從 installed package README/docs/dist 實查；網路連結供公開定位，未聲稱重新查詢 upstream main 或 npm beta。mikan 連結固定於本次 HEAD。

- **[P1]** coding-agent 0.99.2 `dist/extensions/codemode/tool.js`：DESCRIPTION_INTRO、DEFERRED_TOOLS_GUIDANCE、createCodemodeDescription、prepareCodemodeLoadout；`dist/core/system-prompt.js` guidelines 組合。[官方 source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/extensions/codemode/tool.ts)、[system prompt](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts)。
- **[P2]** coding-agent 0.99.2 `dist/extensions/codemode/execute.js`：valueText、formatError、formatCallSummary、truncateOutput、toScriptValue、executeCodemode、createDiscoveryGlobals；`dist/extensions/tool-search/tool.js` ranking。[官方 executor](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/extensions/codemode/execute.ts)、[tool search](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/extensions/tool-search/tool.ts)。
- **[P3]** pi-codemode 0.99.1 `README.md`（Usage、Source format、Declarations、Using with pi-agent-core）、`dist/types.d.ts`（CodemodeResult/CodemodeError/CodemodeTool）、`dist/index.d.ts`、`dist/runtime/prelude-source.js` host rejection bridge、`package.json` exports。[官方 README](https://github.com/earendil-works/pi/blob/main/packages/codemode/README.md)、[types](https://github.com/earendil-works/pi/blob/main/packages/codemode/src/types.ts)、[prelude](https://github.com/earendil-works/pi/blob/main/packages/codemode/src/runtime/prelude-source.ts)。
- **[P4]** coding-agent 0.99.2 `docs/cli.md`：How codemode works；`docs/mcp.md`：tool exposure／codemode result semantics。[CLI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)、[MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)。
- **[P5]** coding-agent 0.99.2 `dist/index.d.ts` public extensions；`docs/sdk.md`：Codemode and MCP。[SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#codemode-mcp)。
- **[P6]** pi-agent-core 0.99.1 `dist/harness/execution/tools.js`：executeToolCall／finalizeToolCall／createToolResultMessage；`dist/harness/agent-harness.d.ts`：public HookMap.after_tool；`dist/harness/hooks.js`：patch 合併。[官方 native executor](https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/execution/tools.ts)、[公開 harness](https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/agent-harness.ts)、[hooks](https://github.com/earendil-works/pi/blob/main/packages/agent/src/harness/hooks.ts)。
- **[M1]** [codemode.ts](https://github.com/geminixiang/mikan/blob/0ccca1c1a711b8ab94b54e12f8bf3baab772a55b/src/harness/tools/codemode.ts)：createCodemodeTool／execute。
- **[M2]** [tools README](https://github.com/geminixiang/mikan/blob/0ccca1c1a711b8ab94b54e12f8bf3baab772a55b/src/harness/tools/README.md#codemode)、[session.ts](https://github.com/geminixiang/mikan/blob/0ccca1c1a711b8ab94b54e12f8bf3baab772a55b/src/harness/session.ts)：setRunTools／executeNestedTool；[tool-search.ts](https://github.com/geminixiang/mikan/blob/0ccca1c1a711b8ab94b54e12f8bf3baab772a55b/src/harness/tools/tool-search.ts)。
- **[M3]** [mcp.ts](https://github.com/geminixiang/mikan/blob/0ccca1c1a711b8ab94b54e12f8bf3baab772a55b/src/harness/mcp.ts)：connectServer／server instructions；[mcp-result.ts](https://github.com/geminixiang/mikan/blob/0ccca1c1a711b8ab94b54e12f8bf3baab772a55b/src/harness/mcp-result.ts)：mcpResultContent／guardMcpToolResult。
- **[M4]** [prompt.ts](https://github.com/geminixiang/mikan/blob/0ccca1c1a711b8ab94b54e12f8bf3baab772a55b/src/harness/prompt.ts)：buildSystemPrompt，不是 Pi CLI prompt builder。
- **[M5]** [前輪研究與 SDK smoke](pi-codemode-discovery-guidance-2026-10.md)：分清對齊前版本與後續 smoke。
- **[E1]** 非公開、本機既有隔離 evidence；公開位置以 placeholder 表示：`<LOCAL_EVIDENCE>/slack-0ccca1c1-<RUN>/verification.json`、`metadata.json`、`mcp-calls.jsonl`、`state/conversations/<OFFICE>/sessions/<SESSION>.jsonl`。保留 commit、compile hash、完成時間與本文匿名結果供本機重新定位；不公開真實 channel/user/message/session IDs、private paths 或 credentials。verifications 與 session outcome 不等於 Slack desktop 全部畫面證明。
