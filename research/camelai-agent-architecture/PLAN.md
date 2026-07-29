# camelAI 架構移植：mikan 實驗規劃

> 研究文件。分析 camelAI（`github.com/qaml-ai/camelAI`，2026-07 clone）如何把 agent
> 從 VM+bash 遷移到 Durable Object + Code Mode，並規劃哪些做法值得在 mikan 上實驗。
> 這份文件只做規劃與範圍界定，不含實作。

## 1. camelAI 做了什麼（摘要）

camelAI 的部落格描述了四個階段，逐步把 coding agent 從「每個使用者一台常開 VM」搬到
「邊緣上的無伺服器執行」：

| 階段 | 做法 | 解決 | 未解決 |
| --- | --- | --- | --- |
| 0. VM era | Claude Code harness + 自建 container 服務 | 能跑 | 每人一台常開 VM，貴、難擴 |
| 1. 腦手分離 | 自建 harness（跑在 pi 上）放進 Cloudflare Durable Object，遠端呼叫 VM 執行指令 | 延遲（agent 不等 VM 開機） | 成本（仍每人一台 VM） |
| 2. 移除 VM | 檔案系統改成 DO SQLite +（大檔）R2，用 Cloudflare `@cloudflare/shell`；git 歷史用 Artifacts | 成本、持久化變成「存資料」而非「養機器」 | bash 仍需要類 Linux 環境 |
| 3. 移除 bash | agent 改寫 **JavaScript**，透過 Code Mode + dynamic Worker loader 在全新 V8 isolate 執行；bash 的用途拆成明確方法（檔案工具 + `deploy_project` / build / notebook 等）；憑證永不進 sandbox | 成本再降數量級、延遲低、便宜/小模型更好開 | 需要事先預想 agent 要什麼能力並內建 |

### 在原始碼裡對應的關鍵機制

- **DO agent**：`workers/main/src/chat-thread-do.ts`（每個 chat thread 一個
  `ChatThreadDO`，繼承 `@cloudflare/ai-chat`，agent loop 用
  `@earendil-works/pi-agent-core`）。
- **Code Mode 執行**：`ChatThreadDO.runCodeModeJavascript()`
  （`chat-thread-do.ts:1071`）。用 `env.CODE_MODE_LOADER`（`WorkerLoader` 綁定）
  把 agent 寫的 JS 包成一個一次性 Worker，注入的 `env` 是一組 **WorkerEntrypoint
  綁定**——`TOOLS`、`AI`、`CAMELAI`、`SECURE_FETCH`、`SCREENSHOT`、`BROWSER`——
  程式碼呼叫這些方法，真正的憑證與 I/O 都留在受信任的 DO 端。isolate 幾毫秒開機、
  幾 MB 記憶體。
- **方法註冊表**：`workers/main/src/code-mode-tools.ts`（`CodeModeToolsBinding`
  這個 `WorkerEntrypoint`；connections runtime、web search、custom domains、
  scheduled prompts 等都掛在這層）。頂層 pi 工具只有
  file / `js_exec` / subagent + 少數 passthrough（`chat-thread/pi-tools.ts`）。
- **檔案系統**：`workers/main/src/workspace-filesystem-do.ts`，用
  `@cloudflare/shell` 的 `Workspace`：小檔存 SQLite row，>~1.5MB 溢出到 R2，row 只
  存指標。對 agent 看起來就是普通 FS。
- **重活仍用容器**：build（Vite/Tailwind/React Router + `bun install`）與 notebook
  透過 Cloudflare Sandbox SDK 開短生命週期容器，做完即關
  （`analysis-sandbox.ts`、`workers/main/*-sandbox.Dockerfile`）。

## 2. 對照：mikan 現況

**關鍵發現：mikan 與 camelAI 建在同一套 pi 基礎上**
（`@earendil-works/pi-agent-core` + `pi-ai`）。camelAI 的 harness 概念可以幾乎直接對映
到 mikan 的 `src/harness/`。差別在執行層與工具形狀，不在 agent loop。

| 面向 | mikan 現況 | camelAI |
| --- | --- | --- |
| Agent loop | `src/harness/`（pi） | `chat-thread-do.ts`（pi） |
| 執行抽象 | `Executor` 介面，核心是 `exec(command)`——**bash 形狀**（`src/sandbox/types.ts`） | 無 bash；`js_exec` + 明確方法綁定 |
| Sandbox 模式 | host / container / image / gondolin(microVM) / firecracker / **cloudflare bridge**（`src/sandbox/`） | DO SQLite+R2 檔案系統 + 一次性 Worker isolate + 按需短命容器 |
| Cloudflare 模式 | `src/sandbox/cloudflare.ts`：HTTP `POST /exec` 打到遠端 bash sandbox = **camelAI 的階段 1** | 已走過並拋棄此形態 |
| 工具 | `read/write/edit/bash/event/sandbox/react/subagent/generate-image`（`src/tools/`） | file 工具 + `js_exec` + subagent |
| 檔案系統 | 主部署 `image:*`：host 跑 mikan、容器跑指令，工作區用 bind-mount 投影（`src/sandbox/README.md`） | DO 內 SQLite/R2 虛擬 FS |
| 憑證 | vault 以 env / file mount 注入到 sandbox（`src/vault/`） | 憑證留服務端，方法呼叫時才用 |

一句話：**mikan 的 `cloudflare` sandbox 正好停在 camelAI 已經拋棄的階段 1**，且整個
`Executor` 抽象是以 bash 為中心。camelAI 的貢獻正是「怎麼往下走到不需要 bash、不需要
常開 VM」。這是 mikan 最直接可借鑑的地方。

## 3. 實驗規劃

每個 track 都可獨立進行、獨立驗證。以「假設 → 範圍與改動點 → 驗證 → 風險 → 工作量」列出。

### Track A — `js_exec` / Code Mode 工具（旗艦實驗）

**假設**：給 agent 一個「寫 JS、由宿主注入方法」的執行面，能在不放棄安全邊界的前提下取代
bash 的大部分用途，並讓便宜/小模型更穩（camelAI 觀察到 open-ended bash 對弱模型不利）。

**範圍與改動點**：
- 新增工具 `src/tools/js-exec.ts`（沿用 `defineHostFnTool` 模式，
  參考 `src/tools/host-fn-tool.ts`）。schema：`{ code: string, timeoutMs?, params? }`。
  注意 mikan 規範要求 tool schema 必須 object-rooted（見 `AGENTS.md`）。
- 定義一組**方法註冊表**（camelAI 的 `TOOLS`/`CONNECTIONS` 對應物）：先從
  mikan 已有能力包起——vault 取密、`event` 排程、平台 upload/react、skills 呼叫。
  介面設計成「agent 的 JS 呼叫 `env.mikan.xxx()`，實作在宿主」。
- 執行後端做成可插拔，先用**最小後端驗證概念**：
  - A1（宿主）：Node `node:worker_threads` + `node:vm` 的受限 context（無 `require`/`fs`/
    `net`，只暴露注入的方法）。快速、能在現有任何部署跑、不綁 Cloudflare。
  - A2（Cloudflare）：真正的 `WorkerLoader` isolate，對映 camelAI
    `runCodeModeJavascript`。需要 workers 專案（見 Track B）。
- 系統提示調整：告訴 agent 何時用 `js_exec` vs `bash`（實驗期兩者並存，用旗標控制）。

**驗證**：
- 單元測試：注入方法可呼叫、逾時、輸出截斷、拒絕存取宿主 API。
- 沿用 mikan 現有 eval/skills 流程跑一組任務（資料處理、多步驟自動化），
  比較 `js_exec` vs `bash` 的成功率與 token 量，並分模型（強 vs 弱）看差異。

**風險**：Node 上 `vm` **不是安全邊界**（只適合概念驗證，正式隔離要靠 isolate/容器）；
方法註冊表的範圍設計是主要工作量；並存兩種執行面會讓提示變複雜。

**工作量**：A1 中；A2 需先有 Track B 才划算。

### Track B — DO + SQLite/R2 檔案系統 executor（無伺服器 sandbox）

**假設**：mikan 可以新增一個 `serverless`/`durable` sandbox 模式，用 DO SQLite（+R2 溢出）
當工作區，取代「cloudflare bridge 打遠端 bash」，達到 camelAI 階段 2 的「無常開 VM」。

**範圍與改動點**：
- 新增 `SandboxAdapter`（對映 `src/sandbox/index.ts` 的註冊表；型別加到
  `src/sandbox/types.ts`，一個 `DurableSandboxConfig`）。
- 因為沒有 bash，這個 executor 不能只實作 `exec()`。有兩條路：
  - B1：executor 提供 file 原語（read/write/edit/glob/grep），bash 相關工具在此模式停用，
    改由 Track A 的 `js_exec` 承接運算——這才是 camelAI 的真正形狀。
  - B2（過渡）：保留 `exec()` 但在 DO 內用有限指令直譯器模擬（僅 file 操作），風險是半吊子。
    建議只做 B1。
- 新增一個 mikan-owned Cloudflare Worker（`workers/` 目錄，新增），內含 DO +
  `@cloudflare/shell` 的 `Workspace`，暴露 file 原語與（Track A 的）isolate loader。
  mikan 主程序透過 RPC/HTTP 呼叫它。
- 評估是否用 Cloudflare Artifacts 做 git 歷史（camelAI 的做法），或先不做版本控制。

**驗證**：
- port `research/workspace-projection` 那套 correctness matrix：可見性、讀寫持久化、
  大檔溢出到 R2、路徑穿越防護、不安全 conversation id。
- 冷啟延遲、每次執行成本，對照現有 container/image 模式。

**風險**：對 `@cloudflare/shell` 的 API/namespace 假設脆弱（camelAI 自己在檔頭警告 v0.3.7 的
`r2Key` 公式若變要同步改）；需要 Cloudflare 帳號資源，CI 難完全本地化；mikan 目前主力是
`image:*` host 模式，這條線是新部署形態而非替換。

**工作量**：大。是四個 track 裡最重的，但也是成本/擴展性論述的核心。

### Track C — 「明確方法 vs 開放 bash」對弱模型的效益（純 eval）

**假設**：camelAI 稱縮小到明確方法集後，便宜模型表現明顯變好。mikan 已有 skills + 工具，
可以在**不改執行層**的情況下先量化這個效益，決定 Track A/B 值不值得。

**範圍與改動點**：
- 不改核心。用 mikan 現有 eval/skills（`src/harness/skills.ts`、`skills/`）設計兩組工具面：
  (i) 完整 bash；(ii) 收斂的明確工具/skills 集。
- 跑同一批任務 × 多個模型（含一個便宜模型），比較成功率、步數、token。

**驗證**：eval 報告（可仿 `reports/*.html` 或 `research/*/RESULTS.md` 格式產出）。

**風險**：低。純量測。結論可能是「mikan 場景下差異不大」——這本身也是有價值的負面結果，
能擋掉 Track A/B 的過度投入。

**工作量**：小到中。**建議最先做**，用來決定後續投入。

### Track D — 重活用短命容器（按需開關）

**假設**：即使走無 bash 路線，build / 特定工具仍需真 Linux。camelAI 的做法是只在需要的
「幾秒」開容器、做完即關。mikan 已有 container/image executor，可加一個「按需生命週期」變體。

**範圍與改動點**：
- mikan 目前 container/image 傾向 per-conversation 常駐（見 `src/sandbox/container.ts`、
  gondolin 的 idle lifecycle）。實驗一個「呼叫時開、回傳後關」的執行封裝，只給
  特定重活工具（例如專案 build）使用。
- 與 Track A 搭配：`js_exec` 承接輕量運算，重活工具背後才落到短命容器。

**驗證**：對照常駐 vs 短命的延遲、資源佔用、正確性（狀態不殘留）。

**風險**：冷啟延遲；狀態在容器間不持久（需明確界定哪些工具可接受無狀態）。

**工作量**：中。可在現有 sandbox 抽象內完成，不需 Cloudflare。

## 4. 建議執行順序

1. **Track C（先做）** — 便宜、能用數據決定要不要投入 A/B。若弱模型效益不明顯，可只做輕量版 A。
2. **Track A1（宿主 js_exec 概念驗證）** — 不綁 Cloudflare，先把「方法註冊表 + JS 執行面」的
   人體工學與提示設計磨出來，跑 eval。
3. **Track B（DO+SQLite/R2）** — 若 A1 + C 證明方向對，再投入最重的無伺服器執行層，
   並把 A 升級成 A2（真 isolate）。
4. **Track D** — 與 B 並行，補齊重活路徑。

## 5. 對映速查表（camelAI → mikan 落點）

| camelAI | mikan 對應/落點 |
| --- | --- |
| `ChatThreadDO` + pi agent loop | `src/harness/runner.ts`（同 pi 基礎） |
| `runCodeModeJavascript` + `CODE_MODE_LOADER` | 新 `src/tools/js-exec.ts` + 新 Cloudflare worker（Track A/B） |
| `CodeModeToolsBinding` 方法註冊表 | 新的宿主方法註冊表，包 vault/event/skills/平台能力 |
| `workspace-filesystem-do.ts`（`@cloudflare/shell`） | 新 `DurableSandbox` adapter（Track B） |
| 短命 build/notebook 容器 | 現有 `container.ts`/`image.ts` 的按需生命週期變體（Track D） |
| Cloudflare Artifacts git 歷史 | 待定（Track B 選配） |
| `cloudflare.ts` 遠端 bash bridge（他們已棄用） | mikan `src/sandbox/cloudflare.ts`——實驗成功後可標記為過渡形態 |
