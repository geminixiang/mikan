# mikan 外部擴充功能開發者比較 DX 稽核

比較基準：mikan 目前 `src/harness/extensions/` 實作、`deploy/examples/extensions/`（尤其 `agent-pm`），以及完整閱讀的 pi 文件 `/Users/geminixiang/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`、其相關 `packages.md`、`session-format.md`、`compaction.md`、`sessions.md` 與相關 examples。以下以「**已驗證**」區分程式碼／文件事實，以「**判斷**」區分 DX 評價。

## (a) 最小 mikan 擴充功能：概念數、陷阱，以及相較 pi 的不利之處

### 結論：至少要理解 11 個概念

假設目標只有：一個 `/counter` 指令、一個持久化 periodic callback schedule、以及一個小型 counter state。外部開發者至少要同時理解下列 **11 個概念**：

1. **模組／factory 形狀**：匯出 default function、named `activate`，或含 `activate` 的 object；`activate` 可 async，也可回傳 disposer。`MikanExtensionActivate` 的精確型別是 `(api: MikanExtensionApi) => void | ExtensionDisposer | Promise<void | ExtensionDisposer>`（`src/harness/extensions/types.ts:661-668`；解析邏輯見 `loader.ts:617-644`）。
2. **package entrypoint 與 jiti**：`package.json.mikan.extensions` 指到 TS/JS entrypoint，無需 build；但 loader 實際只讀陣列第一項（`loader.ts:162-171`、`readMikanManifestEntrypoints`）。
3. **validate／install／activate 是三個不同階段**：validate 會 import、執行 top-level code，但不呼叫 `activate`；install 後還要在受影響對話送 `/pi-new` 才建立新 harness（`src/content/docs/zh-tw/extension-development.mdx:63-127`；`loader.ts:781-846`）。
4. **安裝 scope 不等於執行 instance scope**：global install 只表示程式碼對所有對話可見；`activate` 仍是「每個 Conversation harness 一次」。這是排程重複的根源（文件 `extension-development.mdx:42-60,109-127`；`agent-pm/README.md:72-76`）。
5. **extension identity／slug**：slug 來自安裝檔名或目錄名，不是 package name/display name；它同時鍵控 data、secret、schedule 與 global/conversation shadowing（`loader.ts:252-281`；`types.ts:670-675`）。
6. **command API 與平台路由**：mikan 使用 `registerCommand({ name, description?, handler(context) })`，handler 以 `context.respond()` 回平台；Slack 又因 client-side slash interception 而接受 bare `pm ...`，可能攔到普通句子（`types.ts:277-307`；`registry.ts:50-57,108-121`；`extension-development.mdx:239-273`）。
7. **schedule 的時間模型**：要選 periodic cron + 必填 IANA timezone，或 one-shot ISO timestamp（`types.ts:194-239`）。
8. **schedule 的 action 模型**：同一 schedule 又分 `text`（啟動無歷史 agent run）與 `callback`（host-side deterministic handler、無 model call）；兩者不是小差異，而是完全不同的執行與信任模型（`types.ts:196-239`、`LAYOUT.md:77-91`）。
9. **callback pairing 與持久化 upsert**：callback 必須先／同次 activation 註冊 `onCallback(name, handler)`，schedule 用 `upsert(name, { callback })` 持久化；callback handler 必須在 restart 後重新存在（`types.ts:548-579`；`loader.ts:460-507`）。
10. **state scope**：`api.paths.dataDir` 是 per-conversation 預設；`sharedDataDir` 是跨 conversation opt-in，需自行 tenant partition 與 concurrency control（`types.ts:523-547`；`LAYOUT.md:75-91`）。
11. **state mechanics 與 host capability**：API 只給 directory，不給 read/write/schema/atomic update/lock；schedule、notify、subagent 等表面上是必備 property，但底層 service 可缺席，呼叫時才 throw（`types.ts:408-476,502-659`；`loader.ts:410-429,499-612`）。

### 最可能踩到的坑

**已驗證：**

- **Global extension 會在每個 conversation 重複 activation。** `agent-pm` 必須自行引入 `controlConversationId` 與 `ownsSchedules()`，否則每個 conversation 都註冊一份 daily jobs（`deploy/examples/extensions/agent-pm/src/config.ts:136-146`；`src/index.ts:112-131`）。這不是範例的偶然複雜度，而是現行 tenancy model 的必要 workaround。
- **Schedule text 不繼承 conversation history。** 任務必須 self-contained；把一般 prompt 搬進 schedule 通常會得到資訊不足的 run（`types.ts:196-205,651-658`）。
- **Schedule name 會靜默 sanitize。** 大小寫、空白及標點會 lower-case／轉成 `-`／截到 64 字元；例如 `Daily Check` 與 `daily-check` 可能碰撞。只有 sanitize 後為空才 throw（`loader.ts:237-281`）。
- **Callback 名稱與 schedule 名稱的規則不同。** `onCallback` 僅接受 `/^[a-z0-9_-]+$/i`，duplicate first-wins；schedule name 則被 sanitize（`registry.ts:176-207`；`loader.ts:272-281`）。
- **API capability 是 runtime surprise。** `MikanExtensionApi` 沒有 optional 標記，但 service-less context 會在呼叫時 throw。`agent-pm` 因此手工檢查 `typeof api.schedules?.onCallback` 並拋版本提示（`agent-pm/src/index.ts:68-79`），證明型別本身無法表達最低版本／能力需求。
- **小 state 也得自行處理 crash safety 與並行。** `poll` 直接 `writeFileSync(JSON.stringify(...))`，沒有 atomic replace 或 lock（`deploy/examples/extensions/poll/index.ts:69-86`）；較大型 `agent-pm` 則要自己採 SQLite WAL、busy timeout 與 foreign keys（`agent-pm/src/db.ts:301-325`）。
- **Shared state 的並行是真實情境。** 多個 conversation harness 可同時碰 `sharedDataDir`，多個 schedule 也可能同分鐘觸發；agent-pm 的 WAL/busy-timeout 註解正是因應此事（`agent-pm/src/db.ts:301-314`）。
- **Command collision policy 不可攜。** mikan 內建命令優先、extension duplicate first-wins 且後者被忽略（`registry.ts:103-121`）；pi 則保留同名 extension commands 並產生 `/review:1`、`/review:2`（pi `docs/extensions.md:1505-1538`）。
- **安裝副本與 working copy 不同。** 一般 install 複製程式碼，修改原 checkout 不會更新；`ext dev` 才是 by-reference edit → `/pi-new` loop（`agent-pm/README.md:80-116`；`src/cli/ext-dev.ts:1-22,103-119`）。
- **文件有可觀察的 drift。** `LAYOUT.md` 與 loader 已改用 office key（`LAYOUT.md:13-20,75-91`；`loader.ts:72-91,410-412`），但公開繁中開發文件的安裝表仍寫 `conversations/<conversationId>`（`extension-development.mdx:109-116`），`MikanExtensionApi.paths.dataDir` 註解也仍如此（`types.ts:531-545`）。繁中 hook 表亦漏列實際存在的 `context` hook（文件 `extension-development.mdx:202-215`；實作 `types.ts:94-103,166-192`）。

### 與 pi 相比，不利在哪裡

**已驗證：** pi 沒有與 mikan `api.schedules` 等價的 durable scheduler；完整 extension 文件只警告不要在 factory 啟 timer，要求在 `session_start` 啟動並於 `session_shutdown` 清理（pi `docs/extensions.md:220-224`），examples 的外部觸發是 `fs.watch`（`examples/extensions/file-trigger.ts`）。所以「mikan 能持久化 cron」本身是 mikan 的能力優勢，不應假裝 pi 已有同等功能。

**判斷：** DX 上 mikan 仍明顯較不利，原因是：

- **Golden path 缺席。** pi 有獨立的 minimal command、minimal tool、branch-aware state (`todo.ts`)、file-trigger 與 shutdown examples，且 quick start 直接同頁展示 tool + command（pi `docs/extensions.md:58-100`、`examples/extensions/README.md`）。mikan 目前只有 platform-specific `poll` 與 2,000+ 行的 `agent-pm`；沒有「一 command + 一 durable schedule + 一小 state」可直接抄的 reference。
- **相同底層概念卻有遷移稅。** mikan 建於 pi agent 套件上，但 command、tool、hook context、manifest key 都與 pi extension surface 不同；熟悉 pi 的作者無法只改 import。
- **型別安全較弱。** mikan 公開 `AgentTool`，其 execute 只有 `(toolCallId, params, signal?, onUpdate?)`（`node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:338-348`）；pi 的 `ToolDefinition` 是 generic、參數由 schema 推導，execute 還取得 `ExtensionContext`，並支援 rendering/prompt metadata（pi `dist/core/extensions/types.d.ts:344-376,927-929`）。`agent-pm` 最終對 plain schema 使用 `as any`（`agent-pm/src/index.ts:143-171`）。
- **少量 state 的基礎設施負擔較高。** pi 可用 `appendEntry(customType, data)` 與 `sessionManager` 恢復，或把 branch-sensitive state 放在 tool-result `details`（pi `docs/extensions.md:1458-1476,1866-1900`；`examples/extensions/todo.ts:107-137`）。mikan 只有 directory，作者立即面對 JSON parse、migration、atomicity、permissions 與 concurrency。需注意兩者語意不同：pi state 屬 session/tree；mikan state 屬 conversation office，排程狀態通常反而更適合後者。
- **能力不在型別中。** pi 主要以 mode/context 表達可用性（`ctx.mode`, `ctx.hasUI`；pi `dist/core/extensions/types.d.ts:209-239`）；mikan 則提供 non-optional methods，直到執行才因 embedder/platform 缺 service 而失敗。
- **文件／範例不夠形成單一可信來源。** mikan 的 office-key path 與 `context` hook 已出現文件落差；第一方大型範例甚至要自行做版本 capability probe。對 first-time external developer，這會迫使其閱讀 loader/types/source，而不是只依 public docs。

概念數的公平比較是：pi 若只做「一 command + 一小 session state」約需理解 **5 個概念**（factory/location、command signature、state entry、restore lifecycle、session branching）；若硬要模擬 schedule，還得再理解 timer/watch、`session_start`、`session_shutdown`，且仍不具 restart-durable cron。mikan 的 **11 個概念**有一部分來自它確實提供 pi 沒有的 multi-tenant durable scheduling，但目前 API 沒把這些複雜度壓進較深的 module。

## (b) mikan → pi 的精確機械翻譯表

下表只列核心語意確實相同的項目；欄位或能力只有部分重疊時，明確標示不可攜部分。mikan API 依 `src/harness/extensions/types.ts:502-663`；pi API 依 `dist/core/extensions/types.d.ts:886-968,1136-1143`。

| 語意                               | mikan 精確 symbol／signature                                                                                               | pi 精確 symbol／signature                                                                                                         | 機械翻譯與 caveat                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package entrypoints                | `package.json: { "mikan": { "extensions": string[] } }`                                                                    | `package.json: { "pi": { "extensions": string[] } }`                                                                              | key 改 `mikan` → `pi`。**重要：** mikan loader 目前只取 `[0]`；pi package 可宣告多個 resource entrypoints（mikan `loader.ts:162-171`；pi `docs/extensions.md:241-278`、`docs/packages.md`）。                                                                                                                                         |
| Extension factory                  | `type MikanExtensionActivate = (api: MikanExtensionApi) => void                                                            | ExtensionDisposer                                                                                                                 | Promise<void                                                                                                                                                                                                                                                                                                                          | ExtensionDisposer>`                                                                                                                                                                                                                                                    | `type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>` | default async/sync factory 可直接改參數型別與名稱。mikan 的 named `activate`／object form 需改成 pi default export；mikan 回傳 disposer 在 pi 不生效，改用 `session_shutdown`。 |
| Hook registration 基本形狀         | `api.on<T extends MikanHookName>(hook: T, handler: MikanHookMap[T]): void`，handler 為 `(event) => ...`                    | overloads `pi.on(event, handler: (event, ctx: ExtensionContext) => ...)`                                                          | event name 相同者，保留 name，handler 加第二參數 `ctx`。mikan 的 `origin` 是 event 欄位；pi 的 runtime context 是獨立第二參數。                                                                                                                                                                                                       |
| Before-run hook                    | `on("before_agent_start", (event: {prompt; images?; systemPrompt; origin?}) => {systemPrompt?; prompt?; block?; reason?})` | `on("before_agent_start", (event: {type; prompt; images?; systemPrompt; systemPromptOptions}, ctx) => {message?; systemPrompt?})` | `event.systemPrompt` 與回傳 `systemPrompt` 可機械搬移。mikan 的 `prompt` rewrite、`block/reason`、`origin` 無 pi 同項；pi 的 persistent `message`、`systemPromptOptions` 無 mikan 同項（mikan `types.ts:63-79`; pi `types.d.ts:539-553,830-834`）。                                                                                   |
| LLM context hook                   | `on("context", (event: {messages; origin?}) => {messages?})`                                                               | `on("context", (event: {type; messages}, ctx) => {messages?})`                                                                    | `messages` 與回傳 `{messages}` 直接對應；移除 `origin` 使用，加入第二參數。兩者皆是 call-local context rewrite（mikan `types.ts:94-103`; pi `docs/extensions.md:657-666`）。                                                                                                                                                          |
| Pre-tool gate                      | `on("tool_call", (event: {toolCallId; toolName; args; origin?}) => {block?; reason?})`                                     | `on("tool_call", (event: {type; toolCallId; toolName; input}, ctx) => {block?; reason?; terminate?})`                             | `args` → `input`；`block/reason` 直接對應。pi 的 `input` 可原地 mutate、具 built-in narrowing、可 `terminate`；mikan 無這些保證。錯誤策略也不同：mikan hook error 記錄後略過，pi `tool_call` error fail-safe block（mikan `types.ts:81-92`, header `1-23`; pi `docs/extensions.md:753-798,2901-2906`）。                              |
| Post-tool middleware               | `on("tool_result", ({toolCallId, toolName, args, content, details, isError, usage, origin?}) => partial patch)`            | `on("tool_result", ({type, toolCallId, toolName, input, content, details, isError, usage}, ctx) => partial patch)`                | `args` → `input`；`content/details/isError/usage` 同名直接搬移；移除 `origin` 使用、加入 `ctx`。兩者皆依 load order chain partial patches（mikan `types.ts:105-126`; pi `docs/extensions.md:817-851`）。                                                                                                                              |
| Finalized-message hook             | `on("message_end", ({message, origin?}) => {message?})`                                                                    | `on("message_end", ({type, message}, ctx) => {message?})`                                                                         | `message` 與 replacement 直接對應；兩者都要求 role 不變。mikan 多 `origin`，pi 多 `ctx/type`（mikan `types.ts:128-136`; pi `docs/extensions.md:599-629`）。                                                                                                                                                                           |
| Turn-complete notification         | `on("turn_end", ({messages, origin?}) => void)`                                                                            | `on("turn_end", ({type, turnIndex, message, toolResults}, ctx) => void)`                                                          | lifecycle point 相同，但 payload 要重寫：mikan 的 `messages[]` 不能機械等同 pi 的 `message + toolResults`；只適合「turn 已完成」通知邏輯（mikan `types.ts:138-141`; pi `docs/extensions.md:580-590`）。                                                                                                                               |
| Successful compaction notification | `on("session_compact", ({entry, reason}) => void)`                                                                         | `on("session_compact", ({type, compactionEntry, fromExtension, reason, willRetry}, ctx) => void)`                                 | `entry` → `compactionEntry`，`reason` 保留；pi 多 `fromExtension/willRetry/ctx`（mikan `types.ts:143-147`; pi `docs/extensions.md:454-493`）。                                                                                                                                                                                        |
| Tool registration                  | `registerTool(tool: AgentTool): void`；`execute(toolCallId, params, signal?, onUpdate?)`                                   | `registerTool<TParams,TDetails,TState>(tool: ToolDefinition<...>): void`；`execute(toolCallId, params, signal, onUpdate, ctx)`    | name/label/description/parameters/execute/result content-details 語意相同。Schema import 與 execute signature 要改；pi 多 `ctx`、renderers、prompt metadata、active-tool controls。mikan duplicate tool first-wins；pi 可動態新增並可 override built-ins（mikan `registry.ts:85-101`; pi `docs/extensions.md:1328-1398,2038-2089`）。 |
| Command registration               | `registerCommand(command: {name; description?; handler(context: ExtensionCommandContext): void                             | Promise<void>}): void`                                                                                                            | `registerCommand(name: string, options: {description?; getArgumentCompletions?; handler(args: string, ctx: ExtensionCommandContext): Promise<void>}): void`                                                                                                                                                                           | 拆出 `command.name` 為第一參數；mikan `context.args` → pi 第一個 `args`。mikan `conversationId/userId/userName/threadTs/respond` 沒有 pi 同項；pi `ctx` 則有 UI/session controls。Duplicate policy 不同（mikan `types.ts:277-307`; pi `types.d.ts:876-882,927-929`）。 |
| Resource cleanup                   | `api.onDispose(disposer)` 或 `activate` 回傳 `disposer`                                                                    | `pi.on("session_shutdown", (_event, ctx) => disposer())`                                                                          | 清理 session/harness-scoped resource 的核心語意相同。pi 應讓 handler idempotent，且可看 `reason/targetSessionFile`；mikan disposer LIFO、idempotent registry disposal、錯誤不外拋（mikan `types.ts:274,514-521`; `registry.ts:274-295`; pi `docs/extensions.md:514-527`）。                                                           |
| Working-directory/model context    | `api.context.workspaceDir`, `.model`, `.thinkingLevel`                                                                     | handler/tool `ctx.cwd`, `ctx.model`, `ctx.thinkingLevel`                                                                          | `workspaceDir` → `cwd`；model/thinking 同名。mikan 是 activation instance 上的 readonly context；pi 是每次 callback/tool 的 context，且 model/thinking 可為 `undefined`（mikan `types.ts:522-529`; pi `types.d.ts:209-229`）。                                                                                                        |

### 刻意不放入翻譯表的「假朋友」

下列名稱看似可對應，但語意不相同，因此不能當機械翻譯：

- `mikan api.notify(...)` **不是** pi `ctx.ui.notify(...)`：前者真的向平台 conversation 發訊息並回 platform message id；後者是 TUI/RPC notification。
- `mikan api.triggerRun(text)` **不是** pi `pi.sendUserMessage(text)`：前者啟動不繼承 conversation history 的 autonomous run；後者把真正 user message 寫入目前 session 並使用目前 context（mikan `types.ts:651-658`; pi `docs/extensions.md:1421-1457`）。
- `mikan api.paths.dataDir` **不是** pi `appendEntry`：前者是 conversation-owned host filesystem；後者是 session-tree JSONL entry，具 branch semantics。
- `mikan api.schedules`、`secrets`、`subagent`、`openDm`、`fetchHistory`、`listUsers`、`blockkit`、`react`、`uploadFile` 沒有 pi extension core 的同語意 API。
- mikan `agent_error`、`budget_exceeded` 沒有可精確替代的同名／同終止條件 pi hook；pi `agent_end`／`agent_settled` 只是較廣的 lifecycle notification，不應宣稱等價。

## (c) mikan multi-tenant 特有概念，以及現行 API 是否表達清楚

此處的「pi lacks」是指：pi 主要是一個使用者／project／session runtime；mikan 則是一個 daemon 同時服務多平台、多 workspace、多 conversation office。pi 也有 global/project scope，但沒有 mikan 這種同程序中大量 platform conversations 的租戶隔離責任。

| mikan 特有概念                                     | 為何必要                                                                   | 現行表達                                                                                                                                                                | 判斷                                                                                                                                                               |
| -------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Conversation office 是執行與資源隔離單位**       | 每個平台 conversation 需獨立 workspace、state、session、extension instance | `api.context.conversationId`、`api.paths.dataDir`；host path 由 `OfficeAddress`/office key 產生（`LAYOUT.md:13-20`; `loader.ts:406-412`）                               | **部分清楚。** API 很好地隱藏 office-key path；但沒提供 `api.context.office`／instance identity，文件仍混用 raw conversation id 與 office key。                    |
| **Code scope 與 data scope 是兩條軸**              | global install 不代表 shared state；預設仍應 tenant-isolated               | global/conversation extension directories + `dataDir/sharedDataDir`（`LAYOUT.md:23-48,75-91`; `types.ts:523-547`）                                                      | **概念設計清楚，公開細節有 drift。** 「isolation by default」很好；但 first-time 作者容易把 global install 理解成 singleton activation。                           |
| **每 conversation activation**                     | 每個 office 要綁自己的 hooks/tools/context                                 | loader 針對一個 `LoadExtensionsOptions.context` 建一個 registry/API（`types.ts:702-728`; `loader.ts:646-747`）                                                          | **API 不夠顯式。** `activate(api)` 本身看不出它會被呼叫 N 次；大型例 `agent-pm` 才用註解警告。                                                                     |
| **Extension slug 是跨 scope 的穩定 authority**     | 同一 extension 的 data、secret、schedule、shadowing 必須一致               | slug 由 install root 推導且 lower-case sanitize（`loader.ts:252-281`）                                                                                                  | **對 host 清楚，對作者隱藏。** API 不暴露 `api.identity.slug/sourceScope`；出現資料或 secret 問題時只能從 path/CLI 推理。                                          |
| **Conversation state vs shared application state** | 多 tenant 預設隔離；少數 extension 要跨頻道彙總                            | `paths.dataDir`／`sharedDataDir` 明確二分，註解要求 shared 自行分區及 concurrency（`types.ts:523-547`）                                                                 | **語意清楚，mechanics 不足。** 沒有 atomic store、lock、transaction 或 schema/version helper；最危險的 shared 路徑完全交給 extension。                             |
| **Schedule ownership 必須有 tenant key**           | durable schedule fire 必須回到正確 conversation runtime                    | API 說 schedule 由 extension + conversation 擁有，host filename/store 加 slug/conversation prefix（`types.ts:548-579`; `loader.ts:351-358,455-498`）                    | **conversation-local schedule 清楚；global singleton 不清楚且無一級 API。** `agent-pm` 自建 `controlConversationId` 才避免 N 份 jobs，是目前最大 tenancy footgun。 |
| **跨 conversation／跨 platform addressing**        | shared app 要 post/read/DM 到其他 tenant 或平台                            | `notify` 可帶 `conversationId/platform/threadTs`；`openDm/fetchHistory/listUsers` 以 own platform 為預設；run event 有 `RunOrigin.platform`（`types.ts:44-61,581-639`） | **部分清楚但 stringly typed。** 缺少 `ConversationRef {platform, id}`；不同 method 是否允許 cross-platform 不一致，錯誤只在 runtime 出現。                         |
| **Platform user/message provenance**               | policy、reaction、thread reply 需知道觸發者及原訊息                        | `RunOrigin` 與 `ExtensionCommandContext` 提供 user/message/thread 欄位（`types.ts:44-61,277-296`）                                                                      | **大致清楚。** 但 autonomous event 缺 user/message，需作者自行 null-check；文件有說明。                                                                            |
| **Secret scope 與 tenant credential routing**      | daemon 同時服務多 tenant，credential 是否共用是安全邊界                    | secret store 固定為 `<stateDir>/vaults/extensions/<slug>/env`，API 只有 `get/list`（`LAYOUT.md:42-48`; `types.ts:548-557`）                                             | **不夠清楚。** 這其實是 extension-global secret，不是 per-conversation secret；API 名稱與型別沒有 scope，無法自然表示每 tenant 一組 OAuth/token。                  |
| **Global vs conversation shadowing**               | 某 conversation 要 pin/override global extension 版本                      | collect 時同 slug 後者勝出；global → conversation → explicit root precedence（`loader.ts:713-760`）                                                                     | **host 行為合理，作者觀測性不足。** extension 無法知道自己來自 global 或 conversation scope，也無法報出 shadow source。                                            |
| **Host-authoritative callback boundary**           | sandbox agent 不得偽造會執行 trusted callback 的 schedule                  | callback schedules 存 host-only state；text schedules走 agent-writable event bus（`types.ts:356-390`; `LAYOUT.md:83-91`）                                               | **安全設計清楚，但心智負擔高。** 同一 `api.schedules` 背後其實是兩個 store；錯誤訊息也分 schedule store／callback store。                                          |

總評：mikan 的 tenancy invariants 在內部設計上大多正確，尤其 office-key path、host-only code、per-conversation `dataDir` 與 callback store trust boundary；問題不是「沒有隔離」，而是 **extension-facing API 沒有把 install scope、instance scope、secret scope、global job ownership 與 capability availability 做成可查詢、可型別檢查的一級概念**。因此最複雜的部分只存在註解、LAYOUT 或 agent-pm workaround 中。

## (d) 依 CP 值排序的 exactly three 個最高影響 DX 行動

### 1. 建立唯一 golden-path：`scheduled-counter` starter + `mikan ext init`（成本 S；收益極高；CP #1）

**判斷：** 這是最低成本、最快把 11 個概念壓成一條可複製路徑的行動。

**具體實作：**

- 新增 `deploy/examples/extensions/scheduled-counter/`，限制核心 `index.ts` 約 80–120 行，**恰好**展示：
  1. `registerCommand({ name: "counter" ... })`；
  2. `schedules.onCallback("increment", ...)`；
  3. `schedules.upsert("increment", { type:"periodic", schedule, timezone, callback:"increment" })`；
  4. `api.paths.dataDir` 中一個 versioned JSON state；
  5. temp-file + rename 的 atomic write；
  6. activation idempotency與 `/pi-new`；
  7. conversation-local install，另用明顯警告說 global install 會每 conversation 建 schedule。
- 增加 `mikan ext init <dir> [--template scheduled-counter]`，直接產生 `package.json`、`index.ts`、`README.md` 與一個不需平台 token 的 Vitest/stub smoke test；不要要求作者從 agent-pm 拆出 2,000 行才能找到 API seam。
- 公開文件 Quick Start 改成此範例，並由 CI 對生成 fixture 執行 `mikan ext validate` 與 ext API stub test，防止文件再次與 office-key／hook surface 漂移。

### 2. 加入 manifest capability contract 與 runtime capability introspection（成本 S–M；收益很高；CP #2）

**判斷：** 現在最不友善的失敗模式是「型別說存在，執行才 throw」；`agent-pm` 的手工版本 probe 是直接證據。

**具體實作：**

- 擴充 `package.json.mikan`：
  ```json
  {
    "requires": ["schedules.callback", "state.conversation", "platform.messaging"]
  }
  ```
- 在 `ExtensionManifest` 加 typed `requires`，loader 在 import/activate 前用 `ExtensionHostServices` 驗證；缺 capability 時產生一個完整 activation error，列出 extension slug、缺少能力、目前 platform/context、最低 mikan API level。
- 在 `MikanExtensionApi` 增加 readonly `capabilities`（例如 `has(name)`、`list()`）與 `apiVersion`；需要 graceful degradation 的 extension 可分支，不再做 `typeof api.schedules?.onCallback`。
- `mikan ext validate` 顯示 declared requirements；`mikan ext dev` 啟動時列 capability matrix，明確標出 Block Kit、DM/history 等 terminal backend 沒提供的項目。
- 把現有 `requireScheduleStore`／`requireCallbackScheduleStore` 等 runtime throw 保留為最後防線，但不再作為正常 discovery mechanism。

### 3. 提供 tenant-aware durable state primitive（成本 M；收益極高；CP #3）

**判斷：** directory 是良好的 host abstraction，卻不是良好的 first-time state API。每個 extension 重做 JSON parsing、atomic replace、mode、migration 與 lock，尤其 `sharedDataDir` 會把 correctness 問題放大。

**具體實作：**

- 在 API 增加兩個明確 scope，而非一個帶 option 的模糊 store：
  ```ts
  api.state.conversation.get<T>(key, schema?): Promise<T | undefined>;
  api.state.conversation.set<T>(key, value): Promise<void>;
  api.state.conversation.update<T>(key, updater, schema?): Promise<T>;

  api.state.shared.get/set/update(...);
  ```
- backend 仍落在既有 `dataDir/sharedDataDir`，不新增通用 FileIO abstraction；內部使用 project 已有的 private atomic write pattern，key 驗證、防 path traversal、`0600`，並以 `(scope, slug, office, key)` 的 process-wide mutex 包住 read-modify-write。shared scope 的 key 不含 office，conversation scope 必含 office key。
- 支援可選 TypeBox schema/version envelope，例如 `{version, value}`；schema error 必須指出 extension slug、scope、key、檔案位置，但不可記錄 secret value。
- `paths.*DataDir` 保留給 SQLite/大型資料；文件明確建議「小 state 用 `api.state`，關聯式／大量 state 用 SQLite」。如此可保留 agent-pm 的深度，同時讓 scheduled counter 不必先成為 filesystem/database expert。

這三項的排序理由是：#1 幾乎不改 runtime 即可消除首小時摩擦；#2 把目前的 runtime surprise 前移成可診斷 contract；#3 成本較高，但能永久消除所有小型 state extension 的重複 correctness 工作。三者合起來直接覆蓋本題 minimal extension 的 command、schedule、state 與 multi-tenant failure modes，而不需要先重寫整個 extension system。
