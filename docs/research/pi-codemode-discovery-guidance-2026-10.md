# Pi codemode 與工具探索的模型指引 — 2026-10

> 研究日期：2026-10-01。檢查已安裝的 Pi coding agent **0.99.2** 與 mikan 使用的 pi-codemode **0.99.1**。下列官方 GitHub 連結指向 main，版本判斷以所檢查套件為準，不假設所有版本相同。這次僅研究，未修改產品程式、設定或依賴。

## 結論

Pi 的內建 codemode 不必先載入額外 skill：它把完整的 API 使用說明、全域 helper 清單、探索範例及工具宣告放入 **tool description**，並另提供 system prompt 的批次操作規則。mikan 已使用官方執行引擎，但沒有完整保留這層模型指引。[1][2]

優先借用官方說明結構，並使用已安裝套件的公開 `renderDeclarations({ tools, globals })`，而不是先新增 skill 或引入 Pi CLI 私有模組。[3]

## 官方實際送給模型的內容

| 層次             | 查證結果                                                                                                                                                                                       | 來源   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| codemode 說明    | `DESCRIPTION_INTRO` 明確分開 `tools.<name>(args)` 與 **Global helpers**；列出 `searchTools`、`describeTool`、`describeNamespace` 的參數、回傳語意，以及未 await 的呼叫會被取消等限制。         | [1]    |
| 延遲工具探索     | `DEFERRED_TOOLS_GUIDANCE` 直接寫 `await searchTools(query)`、`await describeNamespace(name)`，並說明未列出的工具仍可由 `tools` 呼叫。                                                          | [1]    |
| 每個工具的宣告   | `prepareCodemodeLoadout()` 在預設 `on` 模式中，將 codemode 宣告附加到直接工具的描述；其他可列出的工具依 namespace 分組放入 codemode 描述。budget 以完整工具區段選取，不是任意截斷整段字串。    | [1][4] |
| system prompt    | codemode 提供 `promptSnippet` 與 `promptGuidelines`；其中要求用 `await Promise.allSettled([...])` 批次處理獨立呼叫。system prompt builder 將所選工具的 guidelines 放入規則區段。               | [1][2] |
| tool_search 說明 | 明確說搜尋 deferred metadata，匹配工具在**下一次模型呼叫**才會被宣告；該工具只提供給模型，不供 script 呼叫。                                                                                   | [5]    |
| MCP 指引         | system prompt 的 `mcp_servers` 區段列出 server 摘要及存取方式；`describeNamespace()` 可按需取得 server instructions 與工具名稱。                                                               | [6]    |
| skill            | Skills 是另一條按需載入詳細工作流程的機制。所查的內建 codemode 實作不依賴專用 `SKILL.md`；官方文件連結的 skill 集合也未找到 codemode/tool_search skill。這不是對所有第三方 skills 的全面盤點。 | [7][8] |

官方指引中的核心用法：

```js
const matches = await searchTools("read_batch", { namespace: "qa" });
text(await describeTool(matches[0].name));
```

這些是**非同步全域函式**，不是 `tools.searchTools` 或 `tools.describeTool`。工具本身才從 `tools.<name>` 呼叫。Pi 的 `describeTool()` 回傳包含描述與宣告的字串；搜尋結果的 `description` 也包含工具 sample，而不只是原始簡介。[1][9]

## mikan 的具體差異（9fdc2a9e，對齊前）

| 項目            | 官方 Pi                                                                                         | mikan 現況                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| helper 說明     | 分區列出全域 helpers，另有明確 `await` 探索範例。                                               | 精簡成一段文字；沒有明確標示兩個探索 helpers 是全域非同步函式。[10]                                    |
| helper 型別     | 引擎的公開 renderer 能產生全域函式宣告及 `Promise` 回傳型別；coding agent 另有詳細文字指引。    | sandbox 注入了 `globals`，但描述只呼叫 `renderDeclarations({ tools: ... })`，沒有傳入 globals。[3][10] |
| 探索結果        | `searchTools()` 的 `description` 包含描述及工具宣告；`describeNamespace()` 提供 server 級指引。 | 搜尋只回傳名稱及原始描述；`describeTool()` 另回傳宣告；尚無 `describeNamespace()`。[9][10]             |
| 工具宣告 budget | 依完整工具區段與 namespace 分配，探索 helpers 的使用指引保留在前面。                            | 對生成的工具宣告直接 `.slice(0, 12_000)`，可能截在宣告中間。[1][10]                                    |
| 搜尋演算法      | BM25，預設 limit 8。                                                                            | 本地加權關鍵字排序，預設 limit 5。[5][11]                                                              |

這些差異可由程式碼確認，但**尚未證明是模型失敗的唯一原因**。尚未做相同模型、相同任務的 Pi/mikan A/B 成功率比較。

## 可以直接借用什麼

1. **借用官方 tool description 的分區與探索範例**，保留 mikan 真正實作的限制。
2. **用現有公開 renderer 輸出 globals**：為 injected helpers 提供 `signature`，同一份定義供 sandbox 與描述使用，避免文件和實作各自維護。已在 mikan 安裝的 0.99.1 執行以下 renderer，確認能產生這些宣告，毋須升級依賴：[3]

   ```ts
   declare function searchTools(
     query: string,
     options?: { limit?: number; namespace?: string },
   ): Promise<Array<{ name: string; description: string }>>;

   declare function describeTool(name: string): Promise<string | undefined>;
   ```

3. **不要整段盲抄官方功能承諾**：Pi 的跨回合 store/load、models/classifier API、describeNamespace、MCP 完整 CallToolResult，以及預設記憶體與 timeout 行為，並非都與 mikan 相同。[1][4][6][10]
4. **不要 deep-import CLI 描述產生器**：所查 coding-agent 公開根入口提供 `createCodemodeExtension()`、`createToolSearchExtension()`；未公開 `createCodemodeDescription()`。整套 extension 是 SDK 的整合路徑，但 mikan 目前使用 pi-agent-core 與自己的 harness，不應為取得文字說明而搬入另一套 CLI runtime。[12]

後續驗證：對齊說明後，以不含額外 helper 教學的原始 E2E 任務重跑；同時確認 globals 宣告不被工具宣告 budget 截掉，以及腳本只輸出聚合結果。這次尚未實作或重測這些變更。

## 後續實作驗證

研究後的對齊改動使用原有 0.99.1 公開 API，沒有新增依賴或引用 CLI 私有模組：

- injected globals 與模型宣告共用定義，透過 `renderDeclarations({ globals })` 產生非同步函式宣告，且不受 nested-tool catalog budget 截斷。
- `searchTools()` 與 `describeTool()` 共用官方 `renderToolSample()` 產生的完整 sample；保留原有 `outputSchema`，沒有輸出 schema 的工具採官方文字回傳預設。
- 先以 session 測試重現缺少全域宣告，以及探索結果缺少 `Promise<string>` 的問題，再驗證修正。既有 label、授權、執行與取消機制不變。
- 全新 SDK session 使用相同的公開測試模型與唯讀 in-process 工具 fixture，不附加全域名稱或 `await` 教學。模型先探索宣告，再平行讀兩個批次並解析 JSON 文字，取得 `total=56`、`kept=4`、`keptSum=48`；原始冗餘欄位未進入模型歷史。這是一次 smoke test，不是成功率比較，也不是對真實 MCP endpoint 的新一輪 E2E。

## 第一方來源

[1]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/extensions/codemode/tool.ts
[2]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts
[3]: https://github.com/earendil-works/pi/blob/main/packages/codemode/README.md#declarations-for-the-model
[4]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md#how-codemode-works
[5]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/extensions/tool-search/tool.ts
[6]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md#control-tool-exposure
[7]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md
[8]: https://github.com/badlogic/pi-skills
[9]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/extensions/codemode/execute.ts
[10]: https://github.com/geminixiang/mikan/blob/9fdc2a9e/src/harness/tools/codemode.ts
[11]: https://github.com/geminixiang/mikan/blob/9fdc2a9e/src/harness/tools/tool-search.ts
[12]: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md#codemode-mcp
