# HKUDS/nanobot 特色研究

> 研究版本：`b0ef759e2ca8647051cab0157854a4b6f741324a`（`pyproject.toml` 版本 0.3.0）  
> Clone 位置：`/Users/geminixiang/Github/nanobot`  
> 本文以 repository 內的原始碼與第一方文件為準；行號皆相對於上述 commit。

## 結論先講

nanobot 的特色不是單純「很小的 chatbot」，而是把**個人 AI agent 工作台**做得相當完整：同一個 runtime 可以從 CLI、WebUI、17 種 chat channel 進入，具備 coding tools、MCP、subagent、模型 fallback、長期記憶、排程與外部 trigger。它最有辨識度的設計是 **Dream 記憶整理與 Git 版控**、**session-bound automation**，以及一個功能完整、偏產品化的自架 WebUI。

但「ultra-lightweight」主要是指核心概念與可讀性，不代表整個專案很小。此 snapshot 約有 118k 行 Python、313 個測試檔；專案自己提供的統計也把 core 算作約 12.8k 行，而 channels 約 53.7k 行。因此它已經是功能廣泛的 agent platform，而不是微型範例。

## 官方宣稱

README 將 nanobot 定位為可自行擁有、self-hosted 的 personal AI agent runtime（`README.md:37`, `README.md:53`），並列出以下能力：

- WebUI 與 terminal（`README.md:55`）
- Telegram、Discord、Slack、WeChat、Email、Mattermost 等 chat apps（`README.md:56`）
- filesystem、shell、web、MCP、cron、image generation、subagent（`README.md:57`）
- session history 與 Dream 長期記憶（`README.md:58`）
- long-horizon goals、scheduled automations（`README.md:59`）
- Python SDK 與 OpenAI-compatible API（`README.md:60`）
- 長駐 gateway 部署（`README.md:61`）

v0.3.0 特別主打 inline subagent、每個 session 切換 model preset、引導式 WebUI setup，以及 provider/channel/tool runtime 的 live config（`README.md:65-73`）。

## 程式碼驗證後，真正突出的特色

### 1. 多入口共用同一套 agent runtime

架構不是每個平台各做一套 bot，而是 channel 把 `InboundMessage` 放入 `MessageBus`，`AgentLoop` 管 session、workspace 與 context，`AgentRunner` 執行 provider/tool loop，再由 bus 回送 channel（`docs/architecture.md:7-22`）。`AgentLoop` 與 `AgentRunner` 的責任也有刻意分層（`docs/architecture.md:33-55`）。

程式碼對同一 session 使用 `asyncio.Lock`，讓同一對話序列化、不同 session 可並行；direct SDK/API 呼叫也共用同一組 session lock（`nanobot/agent/loop.py:1958-1962`）。這比只把 chat adapter 接到單一 prompt function 更適合長時間運行。

目前 source tree 有 17 個 channel package，包括 Slack、Discord、Telegram、Email、WhatsApp、Signal、Matrix、Teams、飛書、微信、企業微信與 QQ 等。channel 是 descriptor/discovery 架構，啟用前會檢查 runtime name collision 與 optional dependency（`nanobot/channels/manager.py:195-240`）。

### 2. Dream：分層、可稽核、可回復的長期記憶

這是 nanobot 最有差異化的部分。它把記憶拆成：

- 當下 session messages
- append-only `memory/history.jsonl`
- `SOUL.md`、`USER.md`、`memory/MEMORY.md` 三個 durable knowledge files
- 記錄 durable files 變化的 Git history

第一方設計說明見 `docs/memory.md:13-24`。`Consolidator` 在 context 壓力上升時，依 user-turn boundary 摘要舊訊息（`nanobot/agent/memory.py:741-789`）；append 時有 cursor、長度上限、去除 reasoning/template leak，以及 thread lock 保護 cursor allocation + append（`nanobot/agent/memory.py:251-290`）。

Dream 再定期讀新 history，對三個 durable files 做小幅整理，且用 Git 保存變更。使用者能 `/dream-log` 查看、`/dream-restore` 回復，並用 workspace-local `prompts/dream.md` 調整整理原則（`docs/memory.md:89-144`）。這解決了常見「agent 靜默改寫記憶、錯了無法追溯」的問題。

### 3. Automation 不只是 cron，而是綁定原 session 的 agent turn

nanobot 有三種背景工作：scheduled automation、local trigger、heartbeat（`docs/automations.md:13-25`）。重點是工作建立於目標 topic，保留原 session history、workspace 和 reply target，而不是孤立的 cron callback（`docs/automations.md:8-11`）。

Local trigger 可從 chat 建立，之後由 CI 或本機腳本呼叫 `nanobot trigger <id>`。訊息先寫 durable queue；session 忙碌時等待 idle，不會插進正在執行的 turn（`docs/automations.md:135-143`）。可靠性明確定義為 at-least-once，並留下 audit record；文件也坦白限制為每 workspace 單 gateway consumer，不是 distributed queue（`docs/automations.md:145-153`）。Heartbeat 則只回報 actionable 結果，壓低例行噪音（`docs/concepts.md:149-157`）。

### 4. Tool 與擴充面完整

工具涵蓋 read/write/edit/patch、shell、web search/fetch、MCP、cron、image generation、subagents 與 runtime self-inspection（`docs/concepts.md:137-145`）。內建工具以 package scanning 自動發現，第三方工具則可透過 Python entry point `nanobot.tools` 註冊（`pyproject.toml:91-96`）。MCP server 直接由 config 掛入，是務實的外部工具擴充方式。

Subagent 支援 background 與 inline 兩種模式；background task 以 `asyncio.create_task` 執行、保存 task/session 關聯，完成後再注入原 session（`nanobot/agent/subagent.py:250-277`），inline 則同步取得結果（`nanobot/agent/subagent.py:279-300`）。

### 5. Provider routing 比一般 OpenAI-compatible wrapper 更成熟

provider registry 是 metadata 的 single source of truth，新 provider 的 env、config matching 與 status display 都由 registry 衍生（`nanobot/providers/registry.py:1-10`）。除了 Anthropic/OpenAI-compatible，source 中另有 Azure OpenAI、Bedrock、GitHub Copilot、OpenAI Codex 與 xAI OAuth adapters。

Fallback provider 並非遇到任何錯誤就盲目切換：它辨識 timeout、connection、5xx、rate limit、overloaded，並有三次失敗、60 秒 cooldown 的 circuit breaker（`nanobot/providers/fallback_provider.py:13-23`）；authentication/permission 類錯誤另外分類（`nanobot/providers/fallback_provider.py:24-48`）。這對長駐 agent 的可用性比單模型設定更實用。

### 6. WebUI 已是管理工作台，不只是聊天頁

WebUI 內含 persistent topics、tool activity、workspace controls、Apps、Skills、settings 與 Automations（`docs/webui.md:1-9`），而且 bundle 隨 wheel 發布。它能做 project/workspace 切換、session fork、MCP presets、skill 管理、provider/channel/security settings 和 automation 管理。初次啟動預設 bind `127.0.0.1`（`docs/webui.md:15-25`）；若綁 `0.0.0.0`，gateway 強制要求 token 或 token issue secret（`docs/webui.md:196-216`）。

## 限制與風險

1. **並非真正的 process sandbox by default。** `restrictToWorkspace` 是 application-level path/command guard；文件明確說不是 process isolation。真正隔離目前只有 Linux `bwrap` backend，Windows 或無 bwrap 的 bare-metal Linux 會直接用 native shell（`.agent/security.md:13-19`, `.agent/security.md:39-45`）。給不受信任使用者 shell tool 時風險很高。
2. **功能面已很大。** 約 118k Python LOC、17 個 channel、313 個測試檔，與「ultra-lightweight」字面印象有落差；維護面積、optional dependencies 與 channel-specific edge cases 都不小。
3. **仍是 Alpha。** package classifier 是 `Development Status :: 3 - Alpha`（`pyproject.toml:14-18`），API 與行為仍可能快速變動。
4. **Memory 會讓模型修改 durable knowledge。** Git audit/restore 很好，但 Dream 仍使用主 agent 模型；文件註明 `modelOverride` 尚未實作，另兩個 config 欄位已 deprecated（`docs/memory.md:146-173`）。錯誤記憶只是可回復，不代表不會發生。
5. **外部 skill 是 prompt-supply-chain boundary。** 官方甚至提供讀取遠端 `skill.md` 加入 agent social network 的流程，但明確警告 nanobot 不會自動稽核 remote skills（`docs/agent-social-network.md:13-24`, `docs/agent-social-network.md:80-86`）。
6. **Local trigger 不等於 webhook platform。** 沒有內建 public webhook receiver，外部服務需自行驗證、格式化並呼叫 CLI；queue 也不是多 consumer 分散式系統（`docs/automations.md:81-84`, `docs/automations.md:145-153`）。

## mikan 最值得借鏡的 5 點

1. **Dream + Git memory history**：把 memory mutation 變成可檢視、可 diff、可 restore 的正式產品能力。
2. **Session-bound automation**：排程與外部 trigger 沿用原 topic 的 session/workspace/reply target，模型得到連續脈絡。
3. **同 session 串行、跨 session 並行**：用清楚的 concurrency invariant 避免 turn 互相污染。
4. **Provider registry single source of truth**：讓 config、偵測、UI/status 與 fallback routing 不各自維護 provider 清單。
5. **安全邊界寫進一級文件**：workspace containment、SSRF、WebUI remote access 與 sandbox 的保證和非保證都寫得明確，尤其坦白 application guard 不等於 process sandbox。

## 整體評價

若目標是「很快架一個可長駐、跨聊天平台、能寫檔跑 shell、可排程且有記憶的私人 agent」，nanobot 的完整度很高，尤其 WebUI、Dream 和 automation 已超過許多 demo 型 agent framework。若目標是把它當多租戶或零信任的 coding-agent service，則不能被 `restrictToWorkspace` 誤導：必須搭配容器或 bwrap，並自行補齊身份、租戶隔離、distributed delivery 與 remote skill governance。
